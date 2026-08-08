import { DEFAULTS, PROVIDERS, loadConfig, saveConfig, parseHostList } from "../common/config.js";

const fields = {
  provider: document.getElementById("provider"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  baseUrl: document.getElementById("baseUrl"),
  effort: document.getElementById("effort"),
  maxSteps: document.getElementById("maxSteps"),
  confirmActions: document.getElementById("confirmActions"),
  askWhereToSave: document.getElementById("askWhereToSave"),
  vision: document.getElementById("vision"),
  blockedHosts: document.getElementById("blockedHosts"),
};

const modelOptions = document.getElementById("modelOptions");
const modelHelp = document.getElementById("modelHelp");
const keyHelp = document.getElementById("keyHelp");
const effortRow = document.getElementById("effortRow");
const saved = document.getElementById("saved");

for (const [id, provider] of Object.entries(PROVIDERS)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = provider.label;
  fields.provider.appendChild(option);
}

/** Show only the settings that apply to the selected provider. */
function syncProviderUI() {
  const provider = PROVIDERS[fields.provider.value] || PROVIDERS.anthropic;

  modelOptions.replaceChildren();
  for (const [id, note] of provider.models || []) {
    const option = document.createElement("option");
    option.value = id;
    option.label = note;
    modelOptions.appendChild(option);
  }

  modelHelp.textContent = (provider.models || []).length
    ? `Suggestions: ${provider.models.map(([id]) => id).join(", ")}. Any model that supports tool calling works.`
    : "Enter the model id exactly as your endpoint expects it. It must support tool calling.";

  keyHelp.replaceChildren();
  if (provider.needsKey === false) {
    keyHelp.textContent = "Not required for a local endpoint — leave blank.";
  } else if (provider.keyUrl) {
    keyHelp.append("Get one at ");
    const link = document.createElement("a");
    link.href = provider.keyUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = provider.keyUrl;
    keyHelp.append(link, ".");
  }

  // Hosted providers come with an endpoint; the field is there for local
  // servers, self-hosted gateways and corporate proxies.
  const required = ["custom"].includes(fields.provider.value);
  document.getElementById("baseUrlLabel").textContent = required ? "API base URL" : "API base URL (optional)";
  document.getElementById("baseUrlHelp").textContent = required
    ? "Must speak the OpenAI /chat/completions format."
    : `Leave blank to use ${provider.baseUrl || "the provider's default endpoint"}. Set it to route through a proxy.`;
  fields.baseUrl.placeholder = provider.baseUrl || "https://api.example.com/v1";

  effortRow.hidden = provider.api !== "anthropic";
}

async function load() {
  const config = await loadConfig();
  fields.provider.value = config.provider;
  fields.apiKey.value = config.apiKey;
  fields.model.value = config.model;
  fields.baseUrl.value = config.baseUrl;
  fields.effort.value = config.effort;
  fields.maxSteps.value = config.maxSteps;
  fields.confirmActions.checked = config.confirmActions;
  fields.askWhereToSave.checked = config.askWhereToSave;
  fields.vision.checked = config.vision;
  fields.blockedHosts.value = (config.blockedHosts || []).join("\n");
  syncProviderUI();
}

fields.provider.addEventListener("change", () => {
  const provider = PROVIDERS[fields.provider.value];
  // Offer that provider's default model rather than leaving a stale id behind.
  const suggested = provider?.models?.[0]?.[0];
  if (suggested) fields.model.value = suggested;
  fields.baseUrl.value = "";
  syncProviderUI();
});

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveConfig({
    provider: fields.provider.value,
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim(),
    baseUrl: fields.baseUrl.value.trim(),
    effort: fields.effort.value,
    maxSteps: Number(fields.maxSteps.value) || DEFAULTS.maxSteps,
    confirmActions: fields.confirmActions.checked,
    askWhereToSave: fields.askWhereToSave.checked,
    vision: fields.vision.checked,
    blockedHosts: parseHostList(fields.blockedHosts.value),
  });
  saved.hidden = false;
  setTimeout(() => {
    saved.hidden = true;
  }, 1800);
});

load();
