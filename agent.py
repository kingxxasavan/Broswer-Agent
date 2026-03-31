"""
agent.py — LLM brain that interprets commands and calls browser tools.
Supports: local Ollama · Anthropic · OpenAI · Google Gemini · OpenRouter · xAI
"""

import json
import re
import asyncio
import httpx
from config import load_config
from browser import TOOLS, TOOL_DESCRIPTIONS

# OpenAI-compatible endpoints — same payload format, different base URL
_OPENAI_COMPAT_URLS = {
    "openai":      "https://api.openai.com/v1/chat/completions",
    "gemini":      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "openrouter":  "https://openrouter.ai/api/v1/chat/completions",
    "xai":         "https://api.x.ai/v1/chat/completions",
}

# Keep only the N most recent history messages to avoid blowing the context
# window on smaller local models (e.g. 3B / 4B).
_MAX_HISTORY = 20

SYSTEM_PROMPT = f"""You are a browser control agent. The user gives you tasks \
and you complete them by controlling a real web browser step by step.

{TOOL_DESCRIPTIONS}

RULES:
- Output ONLY ONE ```json ... ``` block per response — never two or more.
- After each tool result, decide your next step.
- When the task is fully done respond with plain text only (no JSON).
- If something fails, try an alternative before giving up.
- Prefer clicking by visible text over CSS selectors — sites change selectors often.
- Keep reasoning short, be direct.

EXAMPLE:
User: open youtube and search for lofi music
```json
{{"tool": "navigate", "args": {{"url": "https://youtube.com"}}}}
```
[result]
```json
{{"tool": "click", "args": {{"text": "Search"}}}}
```
[result]
```json
{{"tool": "type_text", "args": {{"selector": "input#search", "text": "lofi music"}}}}
```
[result]
```json
{{"tool": "press_key", "args": {{"key": "Enter"}}}}
```
Done — searched YouTube for lofi music.
"""


# ── Helpers ────────────────────────────────────────────────

def _trim_history(history: list) -> list:
    """Keep only the most recent messages so small models don't OOM."""
    if len(history) <= _MAX_HISTORY:
        return history
    return history[-_MAX_HISTORY:]


def _extract_tool_call(text: str) -> dict | None:
    """Pull a JSON tool call out of the model's response."""
    # Primary: ```json { ... } ```
    match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Fallback: raw JSON with a "tool" key anywhere in text
    match = re.search(r'\{\s*"tool"\s*:.+?\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    return None


async def _call_tool(tool_call: dict) -> tuple[str, str | None]:
    """
    Execute a browser tool.
    Returns (text_result, screenshot_b64_or_None).
    The b64 is only set when the screenshot tool ran successfully.
    """
    tool_name = tool_call.get("tool")
    args = tool_call.get("args", {})

    if tool_name not in TOOLS:
        return f"Unknown tool: {tool_name}", None

    try:
        result = await TOOLS[tool_name](**args)
    except Exception as e:
        return f"Tool error: {str(e)}", None

    # Screenshot tool returns {"status": "ok", "base64": "..."}
    if tool_name == "screenshot":
        b64 = result.get("base64", "")
        return "[screenshot captured]", (b64 if b64 else None)

    return json.dumps(result), None


# ── Vision message builders ────────────────────────────────

def _inject_vision_anthropic(messages: list, b64: str) -> list:
    """Inject a screenshot into the last message using Anthropic's image format."""
    messages = list(messages)
    last = messages[-1]
    messages[-1] = {
        "role": last["role"],
        "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": last.get("content", "")},
        ],
    }
    return messages


def _inject_vision_openai(messages: list, b64: str) -> list:
    """Inject a screenshot into the last message using OpenAI's image_url format."""
    messages = list(messages)
    last = messages[-1]
    messages[-1] = {
        "role": last["role"],
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            {"type": "text", "text": last.get("content", "")},
        ],
    }
    return messages


# ── Model callers ──────────────────────────────────────────

async def _call_ollama(model: str, history: list, pending_b64: str | None) -> str:
    import ollama
    client = ollama.AsyncClient()

    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + _trim_history(history)

    # Ollama vision: add "images" field to the last message
    if pending_b64:
        last = messages[-1]
        messages[-1] = {**last, "images": [pending_b64]}

    response = await client.chat(model=model, messages=messages)
    return response["message"]["content"]


async def _call_anthropic(key: str, model: str, history: list, pending_b64: str | None) -> str:
    messages = list(_trim_history(history))
    if pending_b64:
        messages = _inject_vision_anthropic(messages, pending_b64)

    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 1024,
                "system": SYSTEM_PROMPT,
                "messages": messages,
            },
            timeout=30,
        )
    data = r.json()
    if "content" not in data:
        raise RuntimeError(f"Anthropic API error: {data}")
    content = data["content"][0]
    return content.get("text", str(content))


async def _call_openai_compat(
    provider: str, key: str, model: str, history: list, pending_b64: str | None
) -> str:
    """Handles openai / gemini / openrouter / xai — all share the same payload format."""
    url = _OPENAI_COMPAT_URLS[provider]
    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + list(_trim_history(history))

    if pending_b64:
        messages = _inject_vision_openai(messages, pending_b64)

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://github.com/kingxxasavan/Broswer-Agent"

    async with httpx.AsyncClient() as client:
        r = await client.post(
            url,
            headers=headers,
            json={"model": model, "messages": messages},
            timeout=30,
        )
    data = r.json()
    if "choices" not in data:
        raise RuntimeError(f"{provider} API error: {data}")
    return data["choices"][0]["message"]["content"]


# ── Main agent loop ────────────────────────────────────────

async def run_agent_turn(
    user_message: str,
    history: list,
    status_cb=None,
) -> tuple[str, list]:
    """
    Run one user turn through the ReAct loop.
    Returns (final_reply, updated_history).
    status_cb(msg) is called so the TUI spinner stays updated.
    """
    cfg = load_config()
    history = history + [{"role": "user", "content": user_message}]

    max_steps      = cfg.get("max_steps", 15)
    vision_enabled = cfg.get("vision_enabled", False)
    mode           = cfg.get("mode", "local")
    provider       = cfg.get("api_provider", "anthropic")

    final_reply = ""
    pending_b64: str | None = None   # screenshot waiting to be sent to model

    for step in range(max_steps):
        if status_cb:
            status_cb(f"thinking... (step {step + 1})")

        b64_to_send = pending_b64 if vision_enabled else None
        pending_b64 = None   # clear before call so we don't re-send on failure

        # ── Call the right model ───────────────────────────
        try:
            if mode == "local":
                reply_text = await _call_ollama(cfg["local_model"], history, b64_to_send)

            elif provider == "anthropic":
                reply_text = await _call_anthropic(
                    cfg["api_key"], cfg["api_model"], history, b64_to_send
                )

            elif provider in _OPENAI_COMPAT_URLS:
                reply_text = await _call_openai_compat(
                    provider, cfg["api_key"], cfg["api_model"], history, b64_to_send
                )

            else:
                reply_text = f"[error] Unknown provider '{provider}'"

        except Exception as e:
            reply_text = f"[model error: {e}]"

        history.append({"role": "assistant", "content": reply_text})

        # ── Check for tool call ────────────────────────────
        tool_call = _extract_tool_call(reply_text)
        if tool_call:
            tool_name = tool_call.get("tool", "?")
            if status_cb:
                status_cb(f"running: {tool_name}({tool_call.get('args', {})})")

            tool_text, screenshot_b64 = await _call_tool(tool_call)

            if screenshot_b64 and vision_enabled:
                pending_b64 = screenshot_b64   # inject on next LLM call

            history.append({"role": "user", "content": f"[tool result]: {tool_text}"})

        else:
            # No JSON block → agent considers the task done
            final_reply = reply_text.strip()
            break

    else:
        final_reply = "Reached max steps without completing the task."

    return final_reply, history
