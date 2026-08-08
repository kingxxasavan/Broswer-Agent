/** Google Gemini adapter (generateContent with function declarations). */

import { resolveBaseUrl } from "../../common/config.js";

/** Gemini rejects a few JSON Schema keywords, so trim them out. */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue;
    out[key] = typeof value === "object" ? toGeminiSchema(value) : value;
  }
  // Gemini rejects an object schema with an empty properties map.
  if (out.type === "object" && (!out.properties || !Object.keys(out.properties).length)) {
    out.properties = { _unused: { type: "string", description: "Ignored; this tool takes no arguments." } };
  }
  return out;
}

function toContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const parts = [];
      if (message.text) parts.push({ text: message.text });
      for (const call of message.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.input || {} } });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    if (message.toolResults) {
      contents.push({
        role: "user",
        parts: message.toolResults.map((result) => ({
          functionResponse: { name: result.name, response: { result: result.content } },
        })),
      });
      continue;
    }

    const parts = [];
    if (message.image) {
      parts.push({ inlineData: { mimeType: message.image.mediaType, data: message.image.data } });
    }
    parts.push({ text: message.text || "" });
    contents.push({ role: "user", parts });
  }
  return contents;
}

export async function chat({ config, system, messages, tools, signal }) {
  const baseUrl = resolveBaseUrl(config);
  const url = `${baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: toContents(messages),
      tools: [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiSchema(tool.schema),
          })),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 400)}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((part) => part.text)
    .map((part) => part.text)
    .join("\n")
    .trim();

  const toolCalls = parts
    .filter((part) => part.functionCall)
    .map((part, i) => {
      const args = { ...(part.functionCall.args || {}) };
      delete args._unused;
      return { id: `gemini-${Date.now()}-${i}`, name: part.functionCall.name, input: args };
    });

  return { text, toolCalls, usage: data.usageMetadata };
}
