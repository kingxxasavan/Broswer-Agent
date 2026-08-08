/**
 * Smoke test for the browser-control layer.
 *
 * Loads the unpacked extension into Chromium, opens a fixture page and drives
 * the service worker's own browser.js the way the agent's tools do — snapshot,
 * click, type, scroll, iframe traversal, downloads. No API key and no model
 * involved, so this exercises the half of the extension that has to be exactly
 * right before any prompt can work.
 *
 *   npm run smoke
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PAGE = `<!doctype html><html><head><title>Fixture</title></head><body>
  <h1>Widgets Inc</h1>
  <p>We sell widgets. The best plan is Pro at $19/month.</p>
  <input id="q" type="search" placeholder="Search products" />
  <button id="go" onclick="document.getElementById('out').textContent='searched:'+document.getElementById('q').value">Search</button>
  <div id="out"></div>
  <a id="dl" href="/report.txt" download="report.txt">Annual report</a>
  <div style="height:1500px"></div>
  <button id="low">Bottom button</button>
  <iframe src="/frame.html" style="width:300px;height:120px"></iframe>
</body></html>`;

const FRAME = `<!doctype html><html><body>
  <button id="inframe">Inside the iframe</button>
</body></html>`;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A stand-in for the model, speaking the OpenAI wire format. It replies with a
 * scripted sequence of tool calls so the whole agent loop can be exercised
 * without an API key — and records what the extension sent, so we can check the
 * request shape too.
 */
const modelRequests = [];

function mockCompletion(body) {
  modelRequests.push(body);
  const turn = modelRequests.length;

  if (turn === 1) {
    return toolCall("call-1", "read_page", {});
  }
  if (turn === 2) {
    // Prove the page snapshot reached the "model": find the search box index
    // in the tool result we were just given.
    const lastToolResult = [...body.messages].reverse().find((m) => m.role === "tool");
    const match = /\[(\d+)\] <input type=search/.exec(lastToolResult?.content || "");
    if (!match) return finalAnswer("MOCK ERROR: no search box in the page snapshot");
    return toolCall("call-2", "type_text", { index: Number(match[1]), text: "gizmos", submit: false });
  }
  return finalAnswer("Typed gizmos into the search box.");
}

function toolCall(id, name, args) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function finalAnswer(text) {
  return { choices: [{ message: { role: "assistant", content: text } }] };
}

/** The same idea in Anthropic's Messages format, to exercise the SDK path. */
const anthropicRequests = [];

function mockMessages(body) {
  anthropicRequests.push(body);
  if (anthropicRequests.length === 1) {
    return {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body.model,
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Reading the page first." },
        { type: "tool_use", id: "toolu_1", name: "read_page", input: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  const sawSnapshot = JSON.stringify(body.messages).includes("Interactive elements");
  return {
    id: "msg_mock2",
    type: "message",
    role: "assistant",
    model: body.model,
    stop_reason: "end_turn",
    content: [{ type: "text", text: sawSnapshot ? "This is Widgets Inc; Pro costs $19/month." : "MOCK ERROR: no snapshot" }],
    usage: { input_tokens: 20, output_tokens: 8 },
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/anthropic/v1/messages") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(mockMessages(JSON.parse(raw))));
      });
      return;
    }
    if (req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(mockCompletion(JSON.parse(raw))));
      });
      return;
    }
    if (req.url === "/frame.html") {
      res.writeHead(200, { "content-type": "text/html" }).end(FRAME);
    } else if (req.url === "/report.txt") {
      res
        .writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment" })
        .end("annual report contents");
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-agent-smoke-"));
const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-agent-dl-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  // Extensions need the full Chromium build, not the headless shell. Set
  // CHROMIUM_PATH if Playwright's bundled build is not the one you want.
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  downloadsPath: downloadDir,
});

try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  check("service worker started", !!worker);

  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForTimeout(800); // let content scripts attach in every frame

  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab.id;
  });

  // --- snapshot ---------------------------------------------------------
  const snap = await worker.evaluate(async (id) => {
    const { browser } = globalThis.__browserAgentInternals;
    const s = await browser.snapshot(id, { maxElements: 100, maxPageText: 3000 });
    return { url: s.url, title: s.title, lines: s.lines, text: s.text };
  }, tabId);

  check("snapshot returns the page title", snap.title === "Fixture", snap.title);
  check("snapshot lists the search box", snap.lines.some((l) => l.includes("Search products")));
  check("snapshot lists the download link", snap.lines.some((l) => l.includes("Annual report")));
  check(
    "snapshot marks off-screen elements",
    snap.lines.some((l) => l.includes("Bottom button") && l.includes("off-screen")),
  );
  check(
    "snapshot reaches into the iframe",
    snap.lines.some((l) => l.includes("Inside the iframe") && l.includes("in iframe")),
  );
  check("snapshot captures page text", snap.text.includes("Pro at $19/month"));

  const indexOf = (needle) => snap.lines.findIndex((line) => line.includes(needle));

  // --- type + click -----------------------------------------------------
  await worker.evaluate(
    ([id, index]) => globalThis.__browserAgentInternals.browser.typeIntoElement(id, index, "sprockets", false),
    [tabId, indexOf("Search products")],
  );
  check("type_text sets the field value", (await page.inputValue("#q")) === "sprockets");

  await worker.evaluate(
    ([id, index]) => globalThis.__browserAgentInternals.browser.clickElement(id, index),
    [tabId, indexOf('"Search"')],
  );
  await page.waitForTimeout(300);
  check("click fires the page's own handler", (await page.textContent("#out")) === "searched:sprockets");

  // --- iframe click -----------------------------------------------------
  const frameClick = await worker.evaluate(
    ([id, index]) => globalThis.__browserAgentInternals.browser.clickElement(id, index),
    [tabId, indexOf("Inside the iframe")],
  );
  check("click works inside an iframe", frameClick.clicked === "Inside the iframe", JSON.stringify(frameClick));

  // --- scrolling --------------------------------------------------------
  const scrolled = await worker.evaluate(
    (id) => globalThis.__browserAgentInternals.browser.scrollPage(id, "bottom"),
    tabId,
  );
  check("scroll moves the page", scrolled.scrollY > 500, `scrollY=${scrolled.scrollY}`);

  // --- bad index --------------------------------------------------------
  const stale = await worker.evaluate(async (id) => {
    try {
      await globalThis.__browserAgentInternals.browser.clickElement(id, 9999);
      return "no error";
    } catch (err) {
      return err.message;
    }
  }, tabId);
  check("an out-of-range index gives a useful error", /does not exist/.test(stale), stale);

  // --- downloads --------------------------------------------------------
  const href = await worker.evaluate(
    ([id, index]) => globalThis.__browserAgentInternals.browser.hrefOfElement(id, index),
    [tabId, indexOf("Annual report")],
  );
  check("download_element resolves the file URL", href.href.endsWith("/report.txt"), href.href);

  const downloadState = await worker.evaluate(async (url) => {
    const id = await chrome.downloads.download({ url, conflictAction: "uniquify" });
    for (let i = 0; i < 50; i += 1) {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state !== "in_progress") {
        return { state: item.state, filename: item.filename, error: item.error };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { state: "timeout" };
  }, href.href);
  check("a file actually lands on disk", downloadState.state === "complete", JSON.stringify(downloadState));

  // --- unsupported pages ------------------------------------------------
  const blocked = await worker.evaluate(async () => {
    const { browser } = globalThis.__browserAgentInternals;
    const tab = await chrome.tabs.create({ url: "chrome://version", active: false });
    try {
      await browser.snapshot(tab.id, {});
      return "no error";
    } catch (err) {
      return err.message;
    } finally {
      await chrome.tabs.remove(tab.id);
    }
  });
  check("chrome:// pages fail with an explanation", /cannot be controlled/.test(blocked), blocked);

  // --- tool layer -------------------------------------------------------
  const blocklist = await worker.evaluate(async (id) => {
    const { findTool } = globalThis.__browserAgentInternals;
    const session = { tabId: id, messages: [] };
    const config = { blockedHosts: ["127.0.0.1"], askWhereToSave: false };
    try {
      await findTool("click").run({ index: 0 }, { session, config });
      return "no error";
    } catch (err) {
      return err.message;
    }
  }, tabId);
  check("blocked hosts are refused", /blocked-sites list/.test(blocklist), blocklist);

  // --- the whole agent loop, against a mock provider ---------------------
  await page.goto(origin, { waitUntil: "load" }); // reset the fixture
  await page.waitForTimeout(500);

  const transcript = await worker.evaluate(async ([id, base]) => {
    const { agent } = globalThis.__browserAgentInternals;
    await chrome.storage.local.set({
      config: { provider: "custom", apiKey: "test-key", model: "mock-model", baseUrl: base, maxSteps: 8 },
    });
    agent.clear();
    agent.attachTab(id);
    await agent.run("Search this page for gizmos.");
    return agent.log.map((entry) => ({ type: entry.type, tool: entry.tool, text: entry.text }));
  }, [tabId, `${origin}/v1`]);

  const kinds = transcript.map((entry) => entry.type);
  check("agent records the user turn", kinds[0] === "user", JSON.stringify(transcript[0]));
  check(
    "agent ran the tools the model asked for",
    transcript.filter((e) => e.type === "action").map((e) => e.tool).join(",") === "read_page,type_text",
    JSON.stringify(transcript.filter((e) => e.type === "action")),
  );
  check(
    "agent finished with the model's answer",
    transcript.at(-1)?.type === "assistant" && /gizmos/.test(transcript.at(-1).text),
    JSON.stringify(transcript.at(-1)),
  );
  check("no errors in the transcript", !kinds.includes("error"), JSON.stringify(transcript.filter((e) => e.type === "error")));
  check("the agent actually typed into the page", (await page.inputValue("#q")) === "gizmos");

  // --- request shape ----------------------------------------------------
  const first = modelRequests[0];
  const last = modelRequests.at(-1);
  check("request carries a system prompt", first?.messages?.[0]?.role === "system");
  check("request carries tool definitions", (first?.tools || []).some((t) => t.function?.name === "click"));
  check(
    "tool results are fed back with their call ids",
    last.messages.some((m) => m.role === "tool" && m.tool_call_id === "call-1"),
  );
  check(
    "page state is attached to tool results",
    last.messages.some((m) => m.role === "tool" && /Interactive elements:/.test(m.content || "")),
  );

  // --- the Anthropic SDK path -------------------------------------------
  const claudeTranscript = await worker.evaluate(async ([id, base]) => {
    const { agent } = globalThis.__browserAgentInternals;
    await chrome.storage.local.set({
      config: {
        provider: "anthropic",
        apiKey: "sk-ant-test",
        model: "claude-opus-5",
        baseUrl: base,
        effort: "low",
        maxSteps: 6,
      },
    });
    agent.clear();
    agent.attachTab(id);
    await agent.run("What does this page sell?");
    return agent.log.map((entry) => ({ type: entry.type, tool: entry.tool, text: entry.text }));
  }, [tabId, `${origin}/anthropic`]);

  check(
    "Anthropic path runs tools and answers",
    claudeTranscript.some((e) => e.type === "action" && e.tool === "read_page") &&
      /19\/month/.test(claudeTranscript.at(-1)?.text || ""),
    JSON.stringify(claudeTranscript.at(-1)),
  );
  check(
    "Anthropic request uses adaptive thinking and effort",
    anthropicRequests[0]?.thinking?.type === "adaptive" && anthropicRequests[0]?.output_config?.effort === "low",
    JSON.stringify({ thinking: anthropicRequests[0]?.thinking, output_config: anthropicRequests[0]?.output_config }),
  );
  check(
    "Anthropic tools use input_schema",
    (anthropicRequests[0]?.tools || []).every((t) => t.input_schema && t.name && t.description),
  );
  check(
    "assistant turns are replayed as raw content blocks",
    anthropicRequests[1]?.messages?.some(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.id === "toolu_1"),
    ),
  );
  check(
    "tool results come back as tool_result blocks",
    anthropicRequests[1]?.messages?.some(
      (m) => m.role === "user" && m.content.some?.((b) => b.type === "tool_result" && b.tool_use_id === "toolu_1"),
    ),
  );

  // --- extension pages load cleanly -------------------------------------
  const extensionId = new URL(worker.url()).host;
  for (const [name, url, probe] of [
    ["side panel", `chrome-extension://${extensionId}/src/sidepanel/panel.html`, "#composer"],
    ["options page", `chrome-extension://${extensionId}/src/options/options.html`, "#provider"],
  ]) {
    const uiPage = await context.newPage();
    const errors = [];
    uiPage.on("pageerror", (err) => errors.push(err.message));
    uiPage.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    await uiPage.goto(url, { waitUntil: "load" });
    await uiPage.waitForTimeout(400);
    const rendered = await uiPage.locator(probe).count();
    check(`${name} loads without errors`, errors.length === 0, errors.join(" | "));
    check(`${name} renders its controls`, rendered === 1);
    if (name === "side panel") {
      check(
        "side panel replays the transcript",
        (await uiPage.locator(".msg.assistant").last().textContent())?.includes("19/month"),
      );
      check("side panel hides the approval bar when idle", await uiPage.locator("#approval").isHidden());
      check("side panel hides the stop button when idle", await uiPage.locator("#stop").isHidden());
    }
    if (name === "options page") {
      check("options page lists every provider", (await uiPage.locator("#provider option").count()) >= 7);
    }
    if (process.env.SCREENSHOT_DIR) {
      await uiPage.setViewportSize(name === "side panel" ? { width: 400, height: 720 } : { width: 760, height: 1100 });
      await uiPage.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name.replace(/\s/g, "-")}.png`), fullPage: true });
    }
    await uiPage.close();
  }
} finally {
  await context.close();
  server.close();
  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.rm(downloadDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
