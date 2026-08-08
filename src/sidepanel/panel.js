/** Side panel UI. All the thinking happens in the service worker. */

const log = document.getElementById("log");
const empty = document.getElementById("empty");
const input = document.getElementById("input");
const composer = document.getElementById("composer");
const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
const statusChip = document.getElementById("status");
const approvalBox = document.getElementById("approval");
const approvalDetail = document.getElementById("approval-detail");

let port = null;
let pendingApprovalId = null;

// ------------------------------------------------------------- rendering

function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
}

function scrollDown(wasAtBottom) {
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

function summarizeInput(input_) {
  const entries = Object.entries(input_ || {});
  if (!entries.length) return "";
  return entries
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
    })
    .join(" ");
}

/** A tool call and its outcome share one line, keyed by the call id. */
const stepNodes = new Map();

function renderEntry(entry) {
  const wasAtBottom = atBottom();
  empty.hidden = true;

  if (entry.type === "action") {
    const node = document.createElement("div");
    node.className = "step";
    const tool = document.createElement("span");
    tool.className = "tool";
    tool.textContent = entry.tool;
    const args = document.createElement("span");
    args.textContent = ` ${summarizeInput(entry.input)}`;
    node.append(tool, args);
    log.appendChild(node);
    stepNodes.set(entry.id, node);
    scrollDown(wasAtBottom);
    return;
  }

  if (entry.type === "result") {
    const node = stepNodes.get(entry.id);
    const outcome = document.createElement("span");
    outcome.className = `outcome${entry.failed ? " failed" : ""}`;
    outcome.textContent = entry.text;
    (node || log).appendChild(outcome);
    stepNodes.delete(entry.id);
    scrollDown(wasAtBottom);
    return;
  }

  const node = document.createElement("div");
  node.className = `msg ${entry.type}${entry.interim ? " interim" : ""}`;
  node.textContent = entry.text;

  if (entry.openOptions) {
    const button = document.createElement("button");
    button.textContent = "Open settings";
    button.addEventListener("click", () => port?.postMessage({ type: "open-options" }));
    node.appendChild(button);
  }

  log.appendChild(node);
  scrollDown(wasAtBottom);
}

function renderHistory(entries) {
  log.querySelectorAll(".msg, .step").forEach((node) => node.remove());
  stepNodes.clear();
  empty.hidden = entries.length > 0;
  entries.forEach(renderEntry);
  log.scrollTop = log.scrollHeight;
}

function setRunning(running) {
  statusChip.hidden = !running;
  stopButton.hidden = !running;
  sendButton.hidden = running;
}

function showApproval(id, tool, toolInput) {
  pendingApprovalId = id;
  approvalDetail.textContent = `${tool} ${summarizeInput(toolInput)}`.trim();
  approvalBox.hidden = false;
}

function hideApproval() {
  pendingApprovalId = null;
  approvalBox.hidden = true;
}

// --------------------------------------------------------------- wiring

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

async function connect() {
  port = chrome.runtime.connect({ name: "panel" });

  port.onMessage.addListener((message) => {
    switch (message.type) {
      case "history":
        renderHistory(message.entries || []);
        setRunning(!!message.running);
        break;
      case "log":
        renderEntry(message.entry);
        break;
      case "status":
        setRunning(message.running);
        if (!message.running) hideApproval();
        break;
      case "approval-request":
        showApproval(message.id, message.tool, message.input);
        break;
      case "prefill":
        input.value = message.text;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        break;
      default:
        break;
    }
  });

  // The service worker can be torn down when idle; reconnect on demand.
  port.onDisconnect.addListener(() => {
    port = null;
  });

  port.postMessage({ type: "hello", tabId: await currentTabId() });
}

function ensurePort() {
  if (!port) connect();
  return port;
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  ensurePort();
  port?.postMessage({ type: "user-message", text, tabId: await currentTabId() });
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

stopButton.addEventListener("click", () => port?.postMessage({ type: "stop" }));

document.getElementById("clear").addEventListener("click", () => {
  ensurePort();
  port?.postMessage({ type: "clear" });
});

document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

document.getElementById("approve").addEventListener("click", () => {
  port?.postMessage({ type: "approval", id: pendingApprovalId, approved: true });
  hideApproval();
});

document.getElementById("deny").addEventListener("click", () => {
  port?.postMessage({ type: "approval", id: pendingApprovalId, approved: false });
  hideApproval();
});

connect();
input.focus();
