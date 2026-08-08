/**
 * Anthropic adapter — the official SDK.
 *
 * Messages arrive in the neutral shape defined in llm/index.js and are
 * converted to Messages API blocks here. Assistant turns keep the raw content
 * array so thinking blocks are echoed back unchanged on the next turn, which
 * the API requires when continuing on the same model.
 */

import Anthropic from "@anthropic-ai/sdk";
import { resolveBaseUrl } from "../../common/config.js";

/** Models that take adaptive thinking + output_config.effort. */
const ADAPTIVE_THINKING = /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;

function toContent(message) {
  if (message.role === "user") {
    if (message.toolResults) {
      return message.toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      }));
    }
    const blocks = [];
    if (message.image) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: message.image.mediaType, data: message.image.data },
      });
    }
    blocks.push({ type: "text", text: message.text || "" });
    return blocks;
  }

  // Assistant: replay the exact blocks the API gave us when we have them.
  if (message.raw) return message.raw;
  const blocks = [];
  if (message.text) blocks.push({ type: "text", text: message.text });
  for (const call of message.toolCalls || []) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }
  return blocks;
}

export async function chat({ config, system, messages, tools, signal }) {
  const baseURL = resolveBaseUrl(config);
  const client = new Anthropic({
    apiKey: config.apiKey,
    // Required outside Node. The SDK also sends the matching
    // anthropic-dangerous-direct-browser-access header for us.
    dangerouslyAllowBrowser: true,
    ...(baseURL ? { baseURL } : {}),
  });

  const request = {
    model: config.model,
    max_tokens: 16000,
    system,
    messages: messages.map((message) => ({ role: message.role, content: toContent(message) })),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema,
    })),
  };

  if (ADAPTIVE_THINKING.test(config.model)) {
    request.thinking = { type: "adaptive" };
    request.output_config = { effort: config.effort || "high" };
  }

  const response = await client.messages.create(request, { signal });

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    throw new Error(
      `Claude declined this request${category ? ` (${category})` : ""}. Rephrase the task or try a different site.`,
    );
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const toolCalls = response.content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input || {} }));

  return { text, toolCalls, raw: response.content, usage: response.usage };
}
