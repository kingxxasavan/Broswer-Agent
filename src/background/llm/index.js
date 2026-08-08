/**
 * Provider dispatch.
 *
 * The agent loop speaks one neutral message shape and each adapter translates:
 *
 *   { role: "user",      text, image? }
 *   { role: "user",      toolResults: [{ id, name, content, isError? }] }
 *   { role: "assistant", text, toolCalls: [{ id, name, input }], raw? }
 *
 * Adapters return { text, toolCalls, raw?, usage? }.
 */

import { providerApi } from "../../common/config.js";
import { chat as anthropicChat } from "./anthropic.js";
import { chat as openaiChat } from "./openai.js";
import { chat as geminiChat } from "./gemini.js";

const ADAPTERS = {
  anthropic: anthropicChat,
  openai: openaiChat,
  gemini: geminiChat,
};

export async function chat(request) {
  const adapter = ADAPTERS[providerApi(request.config)];
  if (!adapter) throw new Error(`Unsupported provider: ${request.config.provider}`);
  return adapter(request);
}
