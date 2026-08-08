/**
 * The agent loop: ask the model, run the tools it asks for, feed the results
 * back, repeat until it stops calling tools or hits the step ceiling.
 */

import { loadConfig, isConfigured } from "../common/config.js";
import * as browser from "./browser.js";
import { chat } from "./llm/index.js";
import { systemPrompt } from "./prompt.js";
import { toolsFor, findTool } from "./tools.js";

/** How many recent tool results keep their full page snapshot. */
const FULL_SNAPSHOT_HISTORY = 2;

class Stopped extends Error {
  constructor() {
    super("Stopped by the user");
    this.name = "Stopped";
  }
}

/**
 * Older page snapshots are dead weight — the model only ever acts on the
 * newest one. Shrink them so a long session does not blow out the context
 * window (and the bill).
 */
function compactHistory(messages) {
  const resultMessages = messages.filter((message) => message.role === "user" && message.toolResults);
  const stale = resultMessages.slice(0, Math.max(0, resultMessages.length - FULL_SNAPSHOT_HISTORY));
  for (const message of stale) {
    for (const result of message.toolResults) {
      if (result.trimmed || result.content.length <= 300) continue;
      result.content = `${result.content.slice(0, 300)}\n… [page state from an earlier step omitted]`;
      result.trimmed = true;
    }
  }
}

export class Agent {
  /**
   * @param {object} hooks
   * @param {(entry: object) => void} hooks.onLog        transcript entries for the UI
   * @param {(running: boolean) => void} hooks.onStatus
   * @param {(request: object) => Promise<boolean>} hooks.requestApproval
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.session = { tabId: null, messages: [] };
    this.log = [];
    this.running = false;
    this.controller = null;
  }

  emit(entry) {
    const record = { ...entry, at: Date.now() };
    this.log.push(record);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.hooks.onLog(record);
  }

  setRunning(running) {
    this.running = running;
    this.hooks.onStatus(running);
    // MV3 shuts the service worker down after ~30s idle, which would kill a run
    // mid-way (a long `wait`, a slow model). Touching an extension API resets
    // that timer.
    clearInterval(this.keepAlive);
    this.keepAlive = running ? setInterval(() => chrome.runtime.getPlatformInfo(), 20000) : null;
  }

  stop() {
    if (!this.running) return;
    this.stopped = true;
    this.controller?.abort();
  }

  clear() {
    if (this.running) this.stop();
    this.session = { tabId: null, messages: [] };
    this.log = [];
  }

  /** Point the agent at a specific tab (used when the user opens the panel). */
  attachTab(tabId) {
    if (!this.running) this.session.tabId = tabId ?? null;
  }

  async run(userText) {
    if (this.running) {
      this.emit({ type: "error", text: "Still working on the previous request — stop it first." });
      return;
    }

    const config = await loadConfig();
    if (!isConfigured(config)) {
      this.emit({
        type: "error",
        text: "No model configured yet. Open the extension options and add a provider, API key and model.",
        openOptions: true,
      });
      return;
    }

    this.stopped = false;
    this.controller = new AbortController();
    this.setRunning(true);
    this.emit({ type: "user", text: userText });
    this.session.messages.push({ role: "user", text: userText });

    const tools = toolsFor(config);
    const system = systemPrompt(config);
    const maxSteps = Math.min(Math.max(Number(config.maxSteps) || 25, 1), 100);

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        if (this.stopped) throw new Stopped();
        compactHistory(this.session.messages);

        const response = await chat({
          config,
          system,
          messages: this.session.messages,
          tools,
          signal: this.controller.signal,
        });

        this.session.messages.push({
          role: "assistant",
          text: response.text,
          toolCalls: response.toolCalls,
          raw: response.raw,
        });

        if (!response.toolCalls.length) {
          this.emit({ type: "assistant", text: response.text || "(no answer)" });
          return;
        }

        if (response.text) this.emit({ type: "assistant", text: response.text, interim: true });
        await this.runToolCalls(response.toolCalls, config);
      }

      this.emit({
        type: "notice",
        text: `Stopped after ${maxSteps} steps without finishing. Say "keep going" to continue, or raise the step limit in options.`,
      });
    } catch (err) {
      if (err instanceof Stopped || err?.name === "AbortError") {
        this.emit({ type: "notice", text: "Stopped." });
      } else {
        this.emit({ type: "error", text: describeError(err) });
      }
    } finally {
      this.controller = null;
      this.setRunning(false);
    }
  }

  /**
   * Run one round of tool calls. Every call gets a result — including
   * cancellations — because a tool_use block with no matching result makes the
   * next request invalid.
   */
  async runToolCalls(toolCalls, config) {
    const results = [];
    const images = [];

    try {
      for (const call of toolCalls) {
        if (this.stopped) throw new Stopped();

        const tool = findTool(call.name);
        if (!tool) {
          this.emit({ type: "error", text: `Model asked for an unknown tool: ${call.name}` });
          results.push({ id: call.id, name: call.name, content: `No such tool: ${call.name}`, isError: true });
          continue;
        }

        this.emit({ type: "action", id: call.id, tool: call.name, input: call.input });

        if (config.confirmActions) {
          const approved = await this.hooks.requestApproval({ tool: call.name, input: call.input });
          if (!approved) {
            this.emit({ type: "notice", text: `Skipped ${call.name} — you declined it.` });
            results.push({
              id: call.id,
              name: call.name,
              content: "The user declined this action. Do not retry it; ask them what to do instead.",
              isError: true,
            });
            continue;
          }
        }

        try {
          const output = await tool.run(call.input || {}, { session: this.session, config });
          let content = output.text;

          if (tool.refresh) {
            content += `\n\n${await this.pageStateText(config)}`;
          }
          if (output.image) {
            images.push(output.image);
          }

          this.emit({ type: "result", id: call.id, tool: call.name, text: output.text });
          results.push({ id: call.id, name: call.name, content });
        } catch (err) {
          if (err?.name === "AbortError" || this.stopped) throw new Stopped();
          const message = err?.message || String(err);
          this.emit({ type: "result", id: call.id, tool: call.name, text: message, failed: true });
          results.push({ id: call.id, name: call.name, content: `Error: ${message}`, isError: true });
        }
      }
    } finally {
      // Backfill anything we never got to, then record the round.
      for (const call of toolCalls.slice(results.length)) {
        results.push({ id: call.id, name: call.name, content: "Cancelled by the user.", isError: true });
      }
      this.session.messages.push({ role: "user", toolResults: results });
      for (const image of images) {
        this.session.messages.push({ role: "user", text: "Screenshot of the visible part of the tab:", image });
      }
    }
  }

  /** A fresh page snapshot, or an explanation of why there isn't one. */
  async pageStateText(config) {
    try {
      const tab = await browser.resolveTab(this.session);
      const snap = await browser.snapshot(tab.id, {
        maxElements: config.maxElements,
        maxPageText: config.maxPageText,
      });
      return browser.renderSnapshot(snap);
    } catch (err) {
      return `Could not read the page: ${err?.message || err}`;
    }
  }
}

function describeError(err) {
  const message = err?.message || String(err);
  if (/401|invalid x-api-key|unauthorized|invalid api key/i.test(message)) {
    return `Authentication failed — check the API key in the extension options.\n\n${message}`;
  }
  if (/429|rate limit/i.test(message)) {
    return `Rate limited by the provider. Wait a moment and try again.\n\n${message}`;
  }
  if (/Failed to fetch|NetworkError|ERR_/i.test(message)) {
    return `Could not reach the provider. Check your connection, and the base URL if you are using a local or custom endpoint.\n\n${message}`;
  }
  return message;
}
