/**
 * Browser control layer.
 *
 * Owns the conversation with content scripts: which frames exist, how the
 * model's flat element index maps onto (frame, local index), and how to wait
 * for a page to settle after an action.
 */

const CONTENT_SCRIPT = "src/content/content.js";

/** tabId -> [{ frameId, localIndex }] from the most recent snapshot. */
const elementMaps = new Map();

export function forgetTab(tabId) {
  elementMaps.delete(tabId);
}

// ------------------------------------------------------------------- tabs

export async function resolveTab(session) {
  if (session.tabId != null) {
    try {
      return await chrome.tabs.get(session.tabId);
    } catch {
      session.tabId = null;
    }
  }
  const [tab] =
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true })) ||
    (await chrome.tabs.query({ active: true }));
  if (!tab) throw new Error("No open tab to work with — open a page first");
  session.tabId = tab.id;
  return tab;
}

export function isControllable(url) {
  return /^(https?|file):/i.test(url || "");
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Resolve after the tab finishes loading, or after `timeout` either way. */
export function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") setTimeout(finish, 350);
    };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete") setTimeout(finish, 350);
      },
      () => finish(),
    );
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------- frames

async function listFrames(tabId) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {
    frames = [];
  }
  if (!frames.length) frames = [{ frameId: 0, url: "" }];
  return frames
    .filter((f) => !f.url || isControllable(f.url))
    .sort((a, b) => a.frameId - b.frameId);
}

/**
 * Talk to one frame, injecting the content script first if the frame predates
 * the extension (or the last reload).
 */
async function sendToFrame(tabId, frameId, action, payload = {}) {
  const message = { __browserAgent: true, action, payload };
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: [CONTENT_SCRIPT],
    });
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  }
}

async function callFrame(tabId, frameId, action, payload) {
  const response = await sendToFrame(tabId, frameId, action, payload);
  if (!response) throw new Error("The page did not respond — it may still be loading");
  if (!response.ok) throw new Error(response.error || "Page action failed");
  return response.data;
}

// --------------------------------------------------------------- snapshot

function formatElement(index, el, inFrame) {
  const bits = [el.tag];
  if (el.type) bits.push(`type=${el.type}`);
  if (el.role && el.role !== el.tag) bits.push(`role=${el.role}`);
  if (el.checked !== undefined) bits.push(el.checked ? "checked" : "unchecked");
  if (el.disabled) bits.push("disabled");
  if (el.download) bits.push("download");

  let line = `[${index}] <${bits.join(" ")}>`;
  if (el.text) line += ` "${el.text}"`;
  if (el.value) line += ` value="${el.value}"`;
  if (el.href) line += ` -> ${el.href}`;
  if (inFrame) line += " (in iframe)";
  if (!el.inViewport) line += " (off-screen)";
  return line;
}

/**
 * Read the whole tab: every reachable frame's interactive elements, flattened
 * into one index space, plus the visible text.
 */
export async function snapshot(tabId, { maxElements = 150, maxPageText = 4000 } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!isControllable(tab.url)) {
    throw new Error(
      `This page cannot be controlled by an extension (${tab.url || "unknown URL"}). ` +
        "Chrome blocks extensions on chrome:// pages, the Web Store and other browsers' internal pages. " +
        "Navigate to a normal website first.",
    );
  }

  const frames = await listFrames(tabId);
  const map = [];
  const lines = [];
  const texts = [];
  let truncated = false;
  let mainUrl = tab.url;
  let mainTitle = tab.title || "";
  let scroll = null;

  for (const frame of frames) {
    let data;
    try {
      data = await callFrame(tabId, frame.frameId, "snapshot", {
        maxText: frame.frameId === 0 ? maxPageText : Math.min(800, maxPageText),
      });
    } catch {
      continue; // cross-origin frame we cannot reach, or one that just navigated
    }

    if (frame.frameId === 0) {
      mainUrl = data.url;
      mainTitle = data.title;
      scroll = { y: data.scrollY, height: data.scrollHeight };
    }

    for (const el of data.elements) {
      if (map.length >= maxElements) {
        truncated = true;
        break;
      }
      lines.push(formatElement(map.length, el, frame.frameId !== 0));
      map.push({ frameId: frame.frameId, localIndex: el.i });
    }

    if (data.text) {
      texts.push(frame.frameId === 0 ? data.text : `--- iframe ${data.url} ---\n${data.text}`);
    }
    if (truncated) break;
  }

  elementMaps.set(tabId, map);
  return { url: mainUrl, title: mainTitle, lines, text: texts.join("\n\n"), scroll, truncated };
}

/** Render a snapshot into the block of text the model reads. */
export function renderSnapshot(snap, { heading = "Current page" } = {}) {
  const parts = [`${heading}:`, `URL: ${snap.url}`, `Title: ${snap.title || "(none)"}`];
  if (snap.scroll) {
    parts.push(`Scroll: ${snap.scroll.y}px of ${snap.scroll.height}px`);
  }
  parts.push("");
  if (snap.lines.length) {
    parts.push("Interactive elements:");
    parts.push(...snap.lines);
    if (snap.truncated) parts.push("… more elements exist; scroll or narrow the page to reach them");
  } else {
    parts.push("Interactive elements: none found.");
  }
  if (snap.text) {
    parts.push("", "Page text:", snap.text);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------- actions

function locate(tabId, index) {
  const map = elementMaps.get(tabId);
  if (!map || !map.length) {
    throw new Error("No page snapshot yet for this tab — call read_page first");
  }
  const entry = map[index];
  if (!entry) {
    throw new Error(`Element index ${index} does not exist (valid range 0-${map.length - 1}) — call read_page for a fresh list`);
  }
  return entry;
}

export async function clickElement(tabId, index) {
  const { frameId, localIndex } = locate(tabId, index);
  return callFrame(tabId, frameId, "click", { index: localIndex });
}

export async function typeIntoElement(tabId, index, text, submit) {
  const { frameId, localIndex } = locate(tabId, index);
  return callFrame(tabId, frameId, "typeText", { index: localIndex, text, submit });
}

export async function scrollToElement(tabId, index) {
  const { frameId, localIndex } = locate(tabId, index);
  return callFrame(tabId, frameId, "scrollToElement", { index: localIndex });
}

export async function hrefOfElement(tabId, index) {
  const { frameId, localIndex } = locate(tabId, index);
  return callFrame(tabId, frameId, "hrefOf", { index: localIndex });
}

export async function scrollPage(tabId, direction, amount) {
  return callFrame(tabId, 0, "scroll", { direction, amount });
}

export async function pressKey(tabId, key) {
  return callFrame(tabId, 0, "pressKey", { key });
}
