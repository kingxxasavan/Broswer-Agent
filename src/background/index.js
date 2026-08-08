/**
 * Service worker entry point.
 *
 * Owns the single Agent instance and the port to the side panel. The panel is
 * pure UI: it sends user messages and approvals, and renders whatever the
 * agent emits.
 */

import { Agent } from "./agent.js";
import * as browser from "./browser.js";
import { findTool, TOOLS } from "./tools.js";

let panelPort = null;
const pendingApprovals = new Map();
let approvalSeq = 0;

/** Text queued by a context-menu click, handed over when the panel connects. */
let pendingPrefill = null;

function post(message) {
  try {
    panelPort?.postMessage(message);
  } catch {
    panelPort = null;
  }
}

const agent = new Agent({
  onLog: (entry) => post({ type: "log", entry }),
  onStatus: (running) => post({ type: "status", running }),
  requestApproval: ({ tool, input }) =>
    new Promise((resolve, reject) => {
      if (!panelPort) {
        reject(new Error("Approval required but the side panel is closed"));
        return;
      }
      const id = `approval-${++approvalSeq}`;
      pendingApprovals.set(id, { resolve, reject });
      post({ type: "approval-request", id, tool, input });
    }),
});

// --------------------------------------------------------------- side panel

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  panelPort = port;

  port.onDisconnect.addListener(() => {
    if (panelPort === port) panelPort = null;
    for (const { reject } of pendingApprovals.values()) {
      reject(new Error("The side panel was closed before you approved the action"));
    }
    pendingApprovals.clear();
  });

  port.onMessage.addListener(async (message) => {
    switch (message?.type) {
      case "hello": {
        agent.attachTab(message.tabId);
        post({ type: "history", entries: agent.log, running: agent.running });
        if (pendingPrefill) {
          post({ type: "prefill", text: pendingPrefill });
          pendingPrefill = null;
        }
        break;
      }
      case "user-message":
        agent.attachTab(message.tabId);
        agent.run(String(message.text || "").trim());
        break;
      case "stop":
        agent.stop();
        break;
      case "clear":
        agent.clear();
        post({ type: "history", entries: [], running: false });
        break;
      case "approval": {
        const pending = pendingApprovals.get(message.id);
        if (pending) {
          pendingApprovals.delete(message.id);
          pending.resolve(!!message.approved);
        }
        break;
      }
      case "open-options":
        chrome.runtime.openOptionsPage();
        break;
      default:
        break;
    }
  });
});

// ------------------------------------------------------------ context menus

const MENU_PAGE = "browser-agent-page";
const MENU_SELECTION = "browser-agent-selection";
const MENU_LINK = "browser-agent-link";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "Ask Browser Agent about this page",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'Ask Browser Agent about "%s"',
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "Download this link with Browser Agent",
      contexts: ["link"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let text;
  if (info.menuItemId === MENU_PAGE) text = "Read this page and summarise what it says.";
  else if (info.menuItemId === MENU_SELECTION) text = `About this selection from the page:\n\n"${info.selectionText}"\n\n`;
  else if (info.menuItemId === MENU_LINK) text = `Download this file: ${info.linkUrl}`;
  else return;

  if (tab?.id != null) agent.attachTab(tab.id);

  if (panelPort) {
    post({ type: "prefill", text });
  } else {
    pendingPrefill = text;
    // Opening the panel needs the user gesture from the menu click, so do it
    // synchronously-ish and let the panel pick the prefill up on connect.
    try {
      if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch {
      /* the user can open the panel from the toolbar instead */
    }
  }
});

// ----------------------------------------------------------------- cleanup

chrome.tabs.onRemoved.addListener((tabId) => browser.forgetTab(tabId));

/**
 * Handle for tools/smoke-test.mjs. Only code already running inside this
 * extension can reach the service worker's global scope, so this exposes
 * nothing to web pages.
 */
globalThis.__browserAgentInternals = { agent, browser, findTool, TOOLS };
