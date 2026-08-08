/**
 * The agent's tool surface.
 *
 * Every entry declares a JSON schema (sent to the model verbatim) and a `run`
 * function. Tools that change what is on screen set `refresh: true`; the agent
 * loop then appends a fresh page snapshot to the result, so the model always
 * sees current element indices without spending a turn on read_page.
 */

import { isHostBlocked } from "../common/config.js";
import * as browser from "./browser.js";

function sanitizeFilename(name) {
  if (!name) return undefined;
  const cleaned = String(name)
    .replace(/[\\/]+/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .slice(0, 180);
  return cleaned || undefined;
}

function normalizeUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) throw new Error("A URL is required");
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Refuse to touch a host the user has put on the blocklist. */
function assertAllowed(url, config, what) {
  const host = browser.hostOf(url);
  if (isHostBlocked(host, config.blockedHosts)) {
    throw new Error(
      `Blocked by the user's settings: ${host} is on the blocked-sites list, so ${what} is not allowed here. ` +
        "Tell the user rather than trying another route to the same site.",
    );
  }
}

async function currentTab(ctx, { checkBlocklist = true } = {}) {
  const tab = await browser.resolveTab(ctx.session);
  if (checkBlocklist) assertAllowed(tab.url, ctx.config, "acting on this page");
  return tab;
}

export const TOOLS = [
  {
    name: "read_page",
    description:
      "Read the current tab: its URL, title, scroll position, every interactive element with the index used by click/type_text, and the visible text. Use this when you need to see the page before acting, or to re-sync after the page changed on its own.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, ctx) {
      const tab = await currentTab(ctx);
      return { text: `Read ${tab.url}` };
    },
    refresh: true,
  },

  {
    name: "navigate",
    description:
      "Load a URL in the tab you are working in. Use a full URL; a bare domain gets https:// added.",
    schema: {
      type: "object",
      properties: { url: { type: "string", description: "Where to go, e.g. https://example.com/pricing" } },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url }, ctx) {
      const target = normalizeUrl(url);
      assertAllowed(target, ctx.config, "navigation");
      const tab = await browser.resolveTab(ctx.session);
      await chrome.tabs.update(tab.id, { url: target });
      await browser.waitForLoad(tab.id);
      return { text: `Navigated to ${target}` };
    },
    refresh: true,
  },

  {
    name: "click",
    description:
      "Click an element by its index from the most recent page snapshot. Indices change whenever the page changes, so always use the newest list.",
    schema: {
      type: "object",
      properties: { index: { type: "integer", description: "Element index shown in square brackets" } },
      required: ["index"],
      additionalProperties: false,
    },
    async run({ index }, ctx) {
      const tab = await currentTab(ctx);
      const result = await browser.clickElement(tab.id, index);
      await browser.waitForLoad(tab.id, 8000);
      return { text: `Clicked [${index}] ${result.clicked}` };
    },
    refresh: true,
  },

  {
    name: "type_text",
    description:
      "Type into a text field, textarea or contenteditable by index. For a <select>, pass the option's visible text or value. Set submit=true to press Enter afterwards (how you run a search).",
    schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Element index of the field" },
        text: { type: "string", description: "Text to enter — replaces the field's current contents" },
        submit: { type: "boolean", description: "Press Enter after typing. Default false." },
      },
      required: ["index", "text"],
      additionalProperties: false,
    },
    async run({ index, text, submit }, ctx) {
      const tab = await currentTab(ctx);
      const result = await browser.typeIntoElement(tab.id, index, text, !!submit);
      if (submit) await browser.waitForLoad(tab.id, 8000);
      else await browser.sleep(200);
      return { text: `Typed into [${index}] ${result.typedInto}${submit ? " and pressed Enter" : ""}` };
    },
    refresh: true,
  },

  {
    name: "press_key",
    description: "Send a single key to the page, e.g. Enter, Escape, Tab, ArrowDown, PageDown.",
    schema: {
      type: "object",
      properties: { key: { type: "string", description: "KeyboardEvent key name" } },
      required: ["key"],
      additionalProperties: false,
    },
    async run({ key }, ctx) {
      const tab = await currentTab(ctx);
      await browser.pressKey(tab.id, key);
      await browser.sleep(300);
      return { text: `Pressed ${key}` };
    },
    refresh: true,
  },

  {
    name: "scroll",
    description:
      "Scroll the page. Use this when the element list says elements are off-screen, or to load more of an infinite feed.",
    schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Default down" },
        amount: { type: "integer", description: "Pixels to scroll; defaults to about one screen" },
      },
      additionalProperties: false,
    },
    async run({ direction = "down", amount }, ctx) {
      const tab = await currentTab(ctx);
      const result = await browser.scrollPage(tab.id, direction, amount);
      await browser.sleep(400);
      return { text: `Scrolled ${direction} (now at ${result.scrollY}px)` };
    },
    refresh: true,
  },

  {
    name: "scroll_to_element",
    description: "Bring one element into view by index, without clicking it.",
    schema: {
      type: "object",
      properties: { index: { type: "integer" } },
      required: ["index"],
      additionalProperties: false,
    },
    async run({ index }, ctx) {
      const tab = await currentTab(ctx);
      await browser.scrollToElement(tab.id, index);
      await browser.sleep(300);
      return { text: `Scrolled to [${index}]` };
    },
    refresh: true,
  },

  {
    name: "go_back",
    description: "Go back one entry in the tab's history.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, ctx) {
      const tab = await currentTab(ctx);
      await chrome.tabs.goBack(tab.id);
      await browser.waitForLoad(tab.id, 8000);
      return { text: "Went back" };
    },
    refresh: true,
  },

  {
    name: "wait",
    description:
      "Pause before looking again. Use for content that appears after a delay, not as a substitute for reading the page.",
    schema: {
      type: "object",
      properties: { seconds: { type: "number", description: "1-15 seconds" } },
      required: ["seconds"],
      additionalProperties: false,
    },
    async run({ seconds }) {
      const clamped = Math.min(Math.max(Number(seconds) || 1, 0.5), 15);
      await browser.sleep(clamped * 1000);
      return { text: `Waited ${clamped}s` };
    },
    refresh: true,
  },

  {
    name: "download_url",
    description:
      "Download a file to the computer's Downloads folder from a direct URL. Use this for PDFs, images, spreadsheets and other files whose URL you already know.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct URL of the file" },
        filename: { type: "string", description: "Optional name to save it as, e.g. report.pdf or reports/q3.pdf" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url, filename }, ctx) {
      const target = normalizeUrl(url);
      assertAllowed(target, ctx.config, "downloading");
      const id = await chrome.downloads.download({
        url: target,
        filename: sanitizeFilename(filename),
        saveAs: !!ctx.config.askWhereToSave,
        conflictAction: "uniquify",
      });
      const [item] = await chrome.downloads.search({ id });
      return { text: `Started download #${id}: ${item?.filename || target}` };
    },
  },

  {
    name: "download_element",
    description:
      "Download the file a link or image on the page points at, by element index. Use this when the page shows a download link rather than a URL you can read.",
    schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Element index of the link or image" },
        filename: { type: "string", description: "Optional name to save it as" },
      },
      required: ["index"],
      additionalProperties: false,
    },
    async run({ index, filename }, ctx) {
      const tab = await currentTab(ctx);
      const { href, suggestedName } = await browser.hrefOfElement(tab.id, index);
      assertAllowed(href, ctx.config, "downloading");
      const id = await chrome.downloads.download({
        url: href,
        filename: sanitizeFilename(filename || suggestedName),
        saveAs: !!ctx.config.askWhereToSave,
        conflictAction: "uniquify",
      });
      const [item] = await chrome.downloads.search({ id });
      return { text: `Started download #${id} from [${index}]: ${item?.filename || href}` };
    },
  },

  {
    name: "list_downloads",
    description: "Check recent downloads and whether they finished. Use this to confirm a download landed.",
    schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many to list, default 5" } },
      additionalProperties: false,
    },
    async run({ limit = 5 }) {
      const items = await chrome.downloads.search({
        limit: Math.min(Math.max(limit, 1), 20),
        orderBy: ["-startTime"],
      });
      if (!items.length) return { text: "No downloads recorded." };
      const lines = items.map(
        (i) =>
          `#${i.id} ${i.state}${i.error ? ` (${i.error})` : ""} — ${i.filename || i.url}` +
          (i.totalBytes ? ` [${Math.round((i.bytesReceived / i.totalBytes) * 100)}%]` : ""),
      );
      return { text: `Recent downloads:\n${lines.join("\n")}` };
    },
  },

  {
    name: "list_tabs",
    description: "List the open tabs with their ids, so you can switch between them.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, ctx) {
      const tabs = await chrome.tabs.query({});
      const lines = tabs.map(
        (t) => `id=${t.id}${t.id === ctx.session.tabId ? " (working here)" : ""}${t.active ? " (active)" : ""} — ${t.title || "(untitled)"} — ${t.url}`,
      );
      return { text: `Open tabs:\n${lines.join("\n")}` };
    },
  },

  {
    name: "open_tab",
    description: "Open a new tab and start working in it.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        active: { type: "boolean", description: "Bring it to the front. Default true." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url, active = true }, ctx) {
      const target = normalizeUrl(url);
      assertAllowed(target, ctx.config, "navigation");
      const tab = await chrome.tabs.create({ url: target, active });
      ctx.session.tabId = tab.id;
      await browser.waitForLoad(tab.id);
      return { text: `Opened tab ${tab.id} at ${target}` };
    },
    refresh: true,
  },

  {
    name: "switch_tab",
    description: "Continue working in a different tab, by id from list_tabs.",
    schema: {
      type: "object",
      properties: { tab_id: { type: "integer" } },
      required: ["tab_id"],
      additionalProperties: false,
    },
    async run({ tab_id: tabId }, ctx) {
      const tab = await chrome.tabs.get(tabId);
      assertAllowed(tab.url, ctx.config, "acting on this page");
      await chrome.tabs.update(tabId, { active: true });
      ctx.session.tabId = tabId;
      return { text: `Switched to tab ${tabId}: ${tab.url}` };
    },
    refresh: true,
  },

  {
    name: "close_tab",
    description: "Close a tab by id. Only close tabs you opened, unless the user asked otherwise.",
    schema: {
      type: "object",
      properties: { tab_id: { type: "integer" } },
      required: ["tab_id"],
      additionalProperties: false,
    },
    async run({ tab_id: tabId }, ctx) {
      await chrome.tabs.remove(tabId);
      browser.forgetTab(tabId);
      if (ctx.session.tabId === tabId) ctx.session.tabId = null;
      return { text: `Closed tab ${tabId}` };
    },
  },

  {
    name: "screenshot",
    description:
      "Capture the visible part of the tab as an image. Use it when the text and element list are not enough — layout, charts, images, or a page you cannot make sense of otherwise.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    vision: true,
    async run(_input, ctx) {
      const tab = await currentTab(ctx);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
      const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) || [];
      if (!data) throw new Error("Could not capture the tab");
      return { text: "Screenshot captured; it follows as an image.", image: { mediaType, data } };
    },
  },
];

/** Tools available under the current settings, in the shape each provider needs. */
export function toolsFor(config) {
  return TOOLS.filter((tool) => !tool.vision || config.vision);
}

export function findTool(name) {
  return TOOLS.find((tool) => tool.name === name);
}
