"""
agent.py — LLM brain that interprets commands and calls browser tools
Supports local Ollama, Ollama Cloud, and API providers.
"""

import json
import re
import asyncio
from config import load_config
from browser import TOOLS, TOOL_DESCRIPTIONS


SYSTEM_PROMPT = f"""You are a browser control agent. The user gives you tasks and you complete them by controlling a real web browser step by step.

{TOOL_DESCRIPTIONS}

HOW TO RESPOND:
- Think about what steps are needed
- For each step, output ONE tool call as a JSON block wrapped in ```json ... ```
- After the tool result is given back to you, decide the next step
- When the task is fully done, respond with plain text saying what you did (no JSON)
- If something fails, try an alternative approach before giving up
- Keep your thinking short, be direct

EXAMPLE:
User: open youtube and search for lofi music
You: ```json
{{"tool": "navigate", "args": {{"url": "https://youtube.com"}}}}
```
[result comes back]
```json
{{"tool": "click", "args": {{"selector": "input#search"}}}}
```
[result comes back]
```json
{{"tool": "type_text", "args": {{"selector": "input#search", "text": "lofi music"}}}}
```
[result comes back]
```json
{{"tool": "press_key", "args": {{"key": "Enter"}}}}
```
Done — searched YouTube for lofi music.
"""


def _get_ollama_client(cfg: dict):
    import ollama
    if cfg["mode"] == "ollama_cloud":
        return ollama.AsyncClient(
            host=cfg["ollama_cloud_url"],
            headers={"Authorization": f"Bearer {cfg['ollama_cloud_key']}"}
        )
    return ollama.AsyncClient()  # local default


def _get_model_name(cfg: dict) -> str:
    if cfg["mode"] == "local":
        return cfg["local_model"]
    if cfg["mode"] == "ollama_cloud":
        return cfg["ollama_cloud_model"]
    return cfg["api_model"]


def _extract_tool_call(text: str) -> dict | None:
    """Pull out a JSON tool call from the model response."""
    match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # fallback: try raw JSON anywhere in the text
    match = re.search(r'\{\s*"tool"\s*:.+?\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return None


async def _call_tool(tool_call: dict) -> str:
    """Execute a browser tool and return result as string."""
    tool_name = tool_call.get("tool")
    args = tool_call.get("args", {})

    if tool_name not in TOOLS:
        return f"Unknown tool: {tool_name}"

    func = TOOLS[tool_name]
    try:
        result = await func(**args)
        if isinstance(result, str):
            # screenshot returns raw base64, just confirm
            return "[screenshot taken]" if len(result) > 100 else result
        return json.dumps(result)
    except Exception as e:
        return f"Tool error: {str(e)}"


async def run_agent_turn(user_message: str, history: list, status_cb=None) -> tuple[str, list]:
    """
    Run one user turn through the agent loop.
    Returns (final_reply, updated_history)
    status_cb(msg) is called with status updates so the TUI can show them.
    """
    cfg = load_config()
    history = history + [{"role": "user", "content": user_message}]

    max_steps = 12
    final_reply = ""

    for step in range(max_steps):
        if status_cb:
            status_cb(f"thinking... (step {step + 1})")

        # ── Call the model ──
        if cfg["mode"] in ("local", "ollama_cloud"):
            client = _get_ollama_client(cfg)
            model = _get_model_name(cfg)
            response = await client.chat(
                model=model,
                messages=[{"role": "system", "content": SYSTEM_PROMPT}] + history,
            )
            reply_text = response["message"]["content"]

        elif cfg["mode"] == "api":
            reply_text = await _call_api_model(cfg, history)

        else:
            reply_text = "Unknown mode in config."

        history.append({"role": "assistant", "content": reply_text})

        # ── Check for tool call ──
        tool_call = _extract_tool_call(reply_text)

        if tool_call:
            if status_cb:
                status_cb(f"running: {tool_call.get('tool')}({tool_call.get('args', {})})")

            tool_result = await _call_tool(tool_call)
            history.append({"role": "user", "content": f"[tool result]: {tool_result}"})
        else:
            # No tool call = agent is done
            final_reply = reply_text.strip()
            break
    else:
        final_reply = "Reached max steps without completing the task."

    return final_reply, history


async def _call_api_model(cfg: dict, history: list) -> str:
    """Handle external API providers."""
    provider = cfg.get("api_provider", "openai")
    key = cfg.get("api_key", "")
    model = cfg.get("api_model", "gpt-4o")

    if provider == "openai":
        import httpx
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        payload = {
            "model": model,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + history,
        }
        async with httpx.AsyncClient() as client:
            r = await client.post("https://api.openai.com/v1/chat/completions",
                                  headers=headers, json=payload, timeout=30)
            data = r.json()
            return data["choices"][0]["message"]["content"]

    if provider == "anthropic":
        import httpx
        headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model,
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
            "messages": history,
        }
        async with httpx.AsyncClient() as client:
            r = await client.post("https://api.anthropic.com/v1/messages",
                                  headers=headers, json=payload, timeout=30)
            data = r.json()
            return data["content"][0]["text"]

    return "API provider not supported yet."