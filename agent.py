"""
agent.py — LLM brain with fast-path router

Simple commands are handled instantly with zero LLM calls.
Only genuinely complex tasks hit the model.

Fast path covers:
  - Open/go to a known site or any URL
  - New tab, close tab, go back, go forward
  - Scroll up/down
  - Fullscreen, press key shortcuts
  - Search on a specific site
  - Refresh page

Everything else falls through to the LLM agent loop.
"""

import json
import re
import asyncio
from config import load_config
from browser import TOOLS, TOOL_DESCRIPTIONS, get_mode

# ── Known sites ───────────────────────────────────────────────────────────────
# Add any site you use frequently here.
KNOWN_SITES: dict[str, str] = {
    "youtube":      "https://www.youtube.com",
    "google":       "https://www.google.com",
    "gmail":        "https://mail.google.com",
    "github":       "https://www.github.com",
    "reddit":       "https://www.reddit.com",
    "twitter":      "https://www.twitter.com",
    "x":            "https://www.x.com",
    "instagram":    "https://www.instagram.com",
    "netflix":      "https://www.netflix.com",
    "spotify":      "https://open.spotify.com",
    "discord":      "https://discord.com/app",
    "canvas":       "https://canvas.instructure.com",
    "duolingo":     "https://www.duolingo.com",
    "wikipedia":    "https://www.wikipedia.org",
    "amazon":       "https://www.amazon.com",
    "chatgpt":      "https://chatgpt.com",
    "claude":       "https://claude.ai",
    "notion":       "https://www.notion.so",
    "stackoverflow": "https://stackoverflow.com",
}

# Search engine templates
SEARCH_ENGINES: dict[str, str] = {
    "google":     "https://www.google.com/search?q={}",
    "youtube":    "https://www.youtube.com/results?search_query={}",
    "reddit":     "https://www.reddit.com/search/?q={}",
    "github":     "https://github.com/search?q={}",
    "amazon":     "https://www.amazon.com/s?k={}",
    "wikipedia":  "https://en.wikipedia.org/w/index.php?search={}",
    "bing":       "https://www.bing.com/search?q={}",
    "duckduckgo": "https://duckduckgo.com/?q={}",
}


# ── Fast-path router ──────────────────────────────────────────────────────────

def _normalize(text: str) -> str:
    return text.lower().strip()


async def try_fast_path(msg: str) -> str | None:
    """
    Try to handle the message with zero LLM calls.
    Returns a reply string if handled, None if it should go to the LLM.
    """
    m = _normalize(msg)

    # ── URL typed directly ────────────────────────────────────────────────────
    # e.g. "youtube.com" or "https://github.com/kingxxasavan"
    url_match = re.match(
        r'^(https?://\S+|[\w-]+\.(com|org|net|io|dev|ai|edu|gov|co|app|gg|tv|me)(/\S*)?)$',
        m
    )
    if url_match:
        url = m if m.startswith("http") else "https://" + m
        result = await TOOLS["navigate"](url=url)
        return f"Opened {url}"

    # ── "open/go to <site>" ───────────────────────────────────────────────────
    open_match = re.match(
        r'^(?:open|go to|navigate to|launch|load|take me to|visit)\s+(.+)$', m
    )
    if open_match:
        target = open_match.group(1).strip().rstrip(".")
        # Check known sites first
        url = _resolve_site(target)
        if url:
            await TOOLS["navigate"](url=url)
            return f"Opened {target.title()} → {url}"
        # Looks like a raw URL
        if re.search(r'\.\w{2,}', target):
            url = target if target.startswith("http") else "https://" + target
            await TOOLS["navigate"](url=url)
            return f"Navigated to {url}"
        # Can't resolve — fall through to LLM
        return None

    # ── "search <query>" or "search for <query>" (defaults to Google) ─────────
    search_match = re.match(r'^search(?:\s+for)?\s+(.+)$', m)
    if search_match:
        query = search_match.group(1).strip()
        # Strip trailing "on google/youtube/etc"
        on_match = re.search(r'\s+on\s+(\w+)$', query)
        if on_match:
            site = on_match.group(1)
            query = query[:on_match.start()].strip()
            url = _build_search_url(site, query)
        else:
            url = _build_search_url("google", query)
        await TOOLS["navigate"](url=url)
        return f"Searched for \"{query}\""

    # ── "search <query> on <site>" ────────────────────────────────────────────
    search_on_match = re.match(r'^(?:search|look up|find)\s+(.+?)\s+on\s+(\w+)$', m)
    if search_on_match:
        query = search_on_match.group(1).strip()
        site  = search_on_match.group(2).strip()
        url = _build_search_url(site, query)
        await TOOLS["navigate"](url=url)
        return f"Searched {site.title()} for \"{query}\""

    # ── Tab management ────────────────────────────────────────────────────────
    if re.match(r'^(new tab|open new tab|open a new tab)$', m):
        await TOOLS["open_new_tab"]()
        return "Opened a new tab"

    if re.match(r'^(new tab\s+)?open\s+(.+)\s+in\s+(a\s+)?new\s+tab$', m):
        inner = re.match(r'^(?:new tab\s+)?open\s+(.+)\s+in\s+(?:a\s+)?new\s+tab$', m)
        if inner:
            target = inner.group(1).strip()
            url = _resolve_site(target) or ("https://" + target if "." in target else None)
            if url:
                await TOOLS["open_new_tab"](url=url)
                return f"Opened {target.title()} in a new tab"

    if re.match(r'^(close tab|close this tab|close current tab)$', m):
        result = await TOOLS["close_tab"]()
        return result.get("message", "Tab closed")

    # ── Navigation ────────────────────────────────────────────────────────────
    if re.match(r'^(go back|back|previous page)$', m):
        await TOOLS["go_back"]()
        return "Went back"

    if re.match(r'^(go forward|forward|next page)$', m):
        await TOOLS["go_forward"]()
        return "Went forward"

    if re.match(r'^(refresh|reload|refresh page|reload page)$', m):
        await TOOLS["press_key"](key="F5")
        return "Page refreshed"

    # ── Scrolling ─────────────────────────────────────────────────────────────
    scroll_match = re.match(r'^scroll\s*(down|up)(?:\s+(\d+))?$', m)
    if scroll_match:
        direction = scroll_match.group(1)
        amount = int(scroll_match.group(2)) if scroll_match.group(2) else 3
        await TOOLS["scroll"](direction=direction, amount=amount)
        return f"Scrolled {direction}"

    if re.match(r'^(scroll to bottom|jump to bottom|end of page)$', m):
        await TOOLS["scroll_to_bottom"]()
        return "Scrolled to bottom"

    if re.match(r'^(scroll to top|jump to top|top of page)$', m):
        await TOOLS["press_key"](key="ctrl+Home")
        return "Scrolled to top"

    # ── Keyboard shortcuts ────────────────────────────────────────────────────
    if re.match(r'^(fullscreen|full screen|fullscreen mode|theater mode)$', m):
        await TOOLS["press_key"](key="f")   # YouTube/Netflix fullscreen
        return "Toggled fullscreen (pressed F)"

    if re.match(r'^(exit fullscreen|leave fullscreen)$', m):
        await TOOLS["press_key"](key="Escape")
        return "Exited fullscreen"

    if re.match(r'^(pause|play|pause\s*/\s*play|toggle play)$', m):
        await TOOLS["press_key"](key="k")   # YouTube/Netflix space or k
        return "Toggled play/pause"

    if re.match(r'^(mute|unmute|toggle mute)$', m):
        await TOOLS["press_key"](key="m")
        return "Toggled mute"

    if re.match(r'^press\s+(.+)$', m):
        key_raw = re.match(r'^press\s+(.+)$', m).group(1).strip()
        key = _map_key(key_raw)
        await TOOLS["press_key"](key=key)
        return f"Pressed {key_raw}"

    # ── Nothing matched — let the LLM handle it ───────────────────────────────
    return None


def _resolve_site(name: str) -> str | None:
    """Return URL for a known site name, or None."""
    name = name.lower().strip()
    if name in KNOWN_SITES:
        return KNOWN_SITES[name]
    # Partial match — e.g. "youtubes" won't match, but "you tube" won't either
    for key, url in KNOWN_SITES.items():
        if name == key:
            return url
    return None


def _build_search_url(site: str, query: str) -> str:
    site = site.lower()
    encoded = query.replace(" ", "+")
    if site in SEARCH_ENGINES:
        return SEARCH_ENGINES[site].format(encoded)
    # Unknown site — fall back to Google
    return SEARCH_ENGINES["google"].format(encoded)


def _map_key(raw: str) -> str:
    mapping = {
        "enter": "Enter", "return": "Enter",
        "escape": "Escape", "esc": "Escape",
        "tab": "Tab", "space": "Space",
        "backspace": "Backspace", "delete": "Delete",
        "up": "ArrowUp", "down": "ArrowDown",
        "left": "ArrowLeft", "right": "ArrowRight",
        "f5": "F5", "f11": "F11", "f": "f",
        "k": "k", "m": "m",
    }
    return mapping.get(raw.lower(), raw)


# ── System prompt ─────────────────────────────────────────────────────────────

def _build_system_prompt() -> str:
    mode = get_mode()

    if mode == "native":
        example = """\
EXAMPLE (Native mode):

User: find the search bar on youtube and type lofi music
You: ```json
{"tool": "screenshot", "args": {}}
```
[screenshot taken — search bar visible at roughly x=720, y=65]
```json
{"tool": "click", "args": {"x": 720, "y": 65}}
```
[result: {"status": "ok"}]
```json
{"tool": "type_text", "args": {"text": "lofi music"}}
```
[result: {"status": "ok"}]
```json
{"tool": "press_key", "args": {"key": "Enter"}}
```
Done — typed lofi music into the YouTube search bar and hit Enter."""
    else:
        example = """\
EXAMPLE (CDP mode):

User: find the trending videos section on youtube
You: ```json
{"tool": "navigate", "args": {"url": "https://www.youtube.com/feed/trending"}}
```
[result: {"status": "ok", "url": "https://www.youtube.com/feed/trending"}]
Done — opened YouTube Trending."""

    return f"""You are a browser control agent. Complete tasks step by step.

Current mode: {mode.upper()}

{TOOL_DESCRIPTIONS}

RULES:
- Output ONE tool call at a time in a ```json ... ``` block
- After each result, decide the next step
- When done, respond in plain text (no JSON)
- Never repeat the exact same tool call twice — if it failed, try differently
- "needs_coords" means call screenshot() first, then click(x=Y, y=Y)

{example}
"""


# ── LLM helpers ───────────────────────────────────────────────────────────────

def _get_ollama_client(cfg: dict):
    import ollama
    if cfg["mode"] == "ollama_cloud":
        return ollama.AsyncClient(
            host=cfg["ollama_cloud_url"],
            headers={"Authorization": f"Bearer {cfg['ollama_cloud_key']}"}
        )
    return ollama.AsyncClient()


def _get_model_name(cfg: dict) -> str:
    if cfg["mode"] == "local":      return cfg["local_model"]
    if cfg["mode"] == "ollama_cloud": return cfg["ollama_cloud_model"]
    return cfg["api_model"]


def _extract_tool_call(text: str) -> dict | None:
    match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try: return json.loads(match.group(1))
        except json.JSONDecodeError: pass
    match = re.search(r'\{\s*"tool"\s*:.+?\}', text, re.DOTALL)
    if match:
        try: return json.loads(match.group(0))
        except json.JSONDecodeError: pass
    return None


def _tool_key(tool_call: dict) -> str:
    return json.dumps(tool_call, sort_keys=True)


async def _run_tool(tool_call: dict) -> str:
    name = tool_call.get("tool")
    args = tool_call.get("args", {})
    if name not in TOOLS:
        return f"Unknown tool: {name}"
    try:
        result = await TOOLS[name](**args)
        if isinstance(result, str):
            return "[screenshot taken]" if len(result) > 100 else result
        return json.dumps(result)
    except Exception as e:
        return f"Tool error: {e}"


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_agent_turn(
    user_message: str,
    history: list,
    status_cb=None,
) -> tuple[str, list]:
    """
    Run one user turn. Fast path first, LLM loop only if needed.
    Returns (reply, updated_history).
    """

    # ── Fast path — no LLM, no waiting ───────────────────────────────────────
    if status_cb:
        status_cb("routing...")

    fast_reply = await try_fast_path(user_message)
    if fast_reply is not None:
        # Update history so the LLM has context for follow-up questions
        history = history + [
            {"role": "user",      "content": user_message},
            {"role": "assistant", "content": fast_reply},
        ]
        return fast_reply, history

    # ── LLM path — complex tasks ──────────────────────────────────────────────
    if status_cb:
        status_cb("thinking...")

    cfg = load_config()
    history = history + [{"role": "user", "content": user_message}]
    system_prompt = _build_system_prompt()
    max_steps = 12
    final_reply = ""
    last_keys: list[str] = []

    for step in range(max_steps):
        if status_cb:
            status_cb(f"thinking... (step {step + 1})")

        # Call model
        if cfg["mode"] in ("local", "ollama_cloud"):
            client = _get_ollama_client(cfg)
            model  = _get_model_name(cfg)
            resp = await client.chat(
                model=model,
                messages=[{"role": "system", "content": system_prompt}] + history,
            )
            reply_text = resp["message"]["content"]
        elif cfg["mode"] == "api":
            reply_text = await _call_api_model(cfg, history, system_prompt)
        else:
            reply_text = "Unknown mode in config."

        history.append({"role": "assistant", "content": reply_text})

        tool_call = _extract_tool_call(reply_text)
        if not tool_call:
            final_reply = reply_text.strip()
            break

        # Loop guard
        key = _tool_key(tool_call)
        if len(last_keys) >= 2 and all(k == key for k in last_keys[-2:]):
            final_reply = (
                f"Stopped to avoid a loop — "
                f"{tool_call.get('tool')} was called 3 times with identical args. "
                "Try rephrasing your request."
            )
            break
        last_keys.append(key)

        if status_cb:
            preview = str(tool_call.get("args", {}))[:80]
            status_cb(f"{tool_call.get('tool')}({preview})")

        tool_result = await _run_tool(tool_call)
        history.append({"role": "user", "content": f"[tool result]: {tool_result}"})

    else:
        final_reply = "Reached max steps without completing the task."

    return final_reply, history


async def _call_api_model(cfg: dict, history: list, system_prompt: str) -> str:
    provider = cfg.get("api_provider", "openai")
    key      = cfg.get("api_key", "")
    model    = cfg.get("api_model", "gpt-4o")

    if provider == "openai":
        import httpx
        async with httpx.AsyncClient() as c:
            r = await c.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "system", "content": system_prompt}] + history},
                timeout=30,
            )
            return r.json()["choices"][0]["message"]["content"]

    if provider == "anthropic":
        import httpx
        async with httpx.AsyncClient() as c:
            r = await c.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                json={"model": model, "max_tokens": 1024, "system": system_prompt, "messages": history},
                timeout=30,
            )
            return r.json()["content"][0]["text"]

    return "API provider not supported."
