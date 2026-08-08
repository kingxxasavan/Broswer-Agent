/**
 * Settings shared by the service worker, the side panel and the options page.
 * Everything lives in chrome.storage.local so the API key never leaves the
 * machine (chrome.storage.sync would push it to the Google account).
 */

export const DEFAULTS = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-opus-5",
  baseUrl: "", // only used by the "custom" provider (and to override ollama's port)
  effort: "high", // Anthropic only: low | medium | high | xhigh | max
  maxSteps: 25, // hard ceiling on tool-calling rounds per request
  vision: false, // expose the screenshot tool
  confirmActions: false, // ask in the side panel before every action
  askWhereToSave: false, // show the browser's "Save as" dialog for downloads
  blockedHosts: [], // hostnames the agent must not act on
  maxElements: 150, // interactive elements per page snapshot
  maxPageText: 4000, // characters of page text per snapshot
};

/**
 * Provider catalogue. `api` selects the wire format:
 *   anthropic  -> official @anthropic-ai/sdk
 *   openai     -> OpenAI-compatible /chat/completions (covers a lot of hosts)
 *   gemini     -> Google generative language API
 */
export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    api: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      ["claude-opus-5", "Most capable — recommended"],
      ["claude-sonnet-5", "Faster, cheaper, still strong"],
      ["claude-haiku-4-5", "Fastest and cheapest"],
    ],
  },
  openai: {
    label: "OpenAI",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      ["gpt-4.1", "Balanced"],
      ["gpt-4.1-mini", "Fast and cheap"],
      ["gpt-4o", "Vision-friendly"],
    ],
  },
  gemini: {
    label: "Google Gemini",
    api: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/app/apikey",
    models: [
      ["gemini-2.0-flash", "Fast"],
      ["gemini-1.5-pro", "More capable"],
    ],
  },
  openrouter: {
    label: "OpenRouter",
    api: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    models: [
      ["anthropic/claude-sonnet-4.5", "Claude via OpenRouter"],
      ["openai/gpt-4.1-mini", "GPT-4.1 mini"],
      ["google/gemini-2.0-flash-001", "Gemini Flash"],
    ],
  },
  groq: {
    label: "Groq",
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: [["llama-3.3-70b-versatile", "Llama 3.3 70B"]],
  },
  xai: {
    label: "xAI (Grok)",
    api: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    models: [
      ["grok-3", "Most capable"],
      ["grok-3-mini", "Fast and cheap"],
    ],
  },
  ollama: {
    label: "Ollama (local)",
    api: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    models: [
      ["qwen3:8b", "Needs a tool-calling model"],
      ["llama3.1:8b", "Tool calling supported"],
    ],
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    api: "openai",
    baseUrl: "",
    models: [],
  },
};

export async function loadConfig() {
  const stored = await chrome.storage.local.get("config");
  return { ...DEFAULTS, ...(stored.config || {}) };
}

export async function saveConfig(patch) {
  const next = { ...(await loadConfig()), ...patch };
  await chrome.storage.local.set({ config: next });
  return next;
}

/** Resolved endpoint for a provider, honouring a user-supplied override. */
export function resolveBaseUrl(config) {
  const provider = PROVIDERS[config.provider] || PROVIDERS.anthropic;
  return (config.baseUrl || provider.baseUrl || "").replace(/\/+$/, "");
}

export function providerApi(config) {
  return (PROVIDERS[config.provider] || PROVIDERS.anthropic).api;
}

/** True when the configuration is complete enough to make a request. */
export function isConfigured(config) {
  const provider = PROVIDERS[config.provider];
  if (!provider) return false;
  if (provider.needsKey !== false && !config.apiKey) return false;
  if (!config.model) return false;
  if (provider.api !== "anthropic" && !resolveBaseUrl(config)) return false;
  return true;
}

/** Parse the blocked-hosts textarea into a normalised list. */
export function parseHostList(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

/** A host is blocked if it matches an entry exactly or is a subdomain of it. */
export function isHostBlocked(host, blockedHosts) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  return (blockedHosts || []).some((b) => h === b || h.endsWith("." + b));
}
