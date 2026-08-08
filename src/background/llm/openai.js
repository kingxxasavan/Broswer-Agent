/**
 * OpenAI-compatible /chat/completions adapter.
 *
 * Covers OpenAI itself plus every host that speaks the same wire format:
 * OpenRouter, Groq, xAI, Ollama and any custom endpoint the user points at.
 */

import { resolveBaseUrl } from "../../common/config.js";

function toMessages(system, messages) {
  const out = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "assistant") {
      const entry = { role: "assistant", content: message.text || null };
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input || {}) },
        }));
      }
      out.push(entry);
      continue;
    }

    if (message.toolResults) {
      for (const result of message.toolResults) {
        out.push({ role: "tool", tool_call_id: result.id, content: result.content });
      }
      continue;
    }

    if (message.image) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: message.text || "" },
          {
            type: "image_url",
            image_url: { url: `data:${message.image.mediaType};base64,${message.image.data}` },
          },
        ],
      });
      continue;
    }

    out.push({ role: "user", content: message.text || "" });
  }

  return out;
}

export async function chat({ config, system, messages, tools, signal }) {
  const baseUrl = resolveBaseUrl(config);
  if (!baseUrl) throw new Error("No API endpoint configured — set a base URL in the extension options");

  const headers = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (config.provider === "openrouter") {
    headers["x-title"] = "Browser Agent";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      messages: toMessages(system, messages),
      tools: tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.schema },
      })),
      tool_choice: "auto",
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${config.provider} request failed (${response.status}): ${body.slice(0, 400)}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  const choice = data.choices?.[0];
  if (!choice) throw new Error("The model returned no choices");

  const toolCalls = (choice.message?.tool_calls || []).map((call) => {
    let input = {};
    try {
      input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      throw new Error(`The model produced invalid JSON arguments for ${call.function?.name}`);
    }
    return { id: call.id, name: call.function.name, input };
  });

  return { text: (choice.message?.content || "").trim(), toolCalls, usage: data.usage };
}
