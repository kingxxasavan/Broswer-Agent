"""
browser.py — Dual-mode browser control

MODE 1 — CDP (Playwright):
  Chrome was launched with --remote-debugging-port=9222
  Full programmatic control.

MODE 2 — Native (pyautogui):
  Chrome is just open normally, no debug port needed.
  Controls Chrome via OS-level mouse/keyboard + screenshots.

On startup, CDP is tried first. If it fails, Native mode kicks in automatically.
Never opens a fresh Chromium. Never closes your existing Chrome.
"""

import asyncio
import base64
import io
import socket
import subprocess
import time
import os
import pyautogui
import pygetwindow as gw
import pyperclip
from playwright.async_api import async_playwright, Page, Browser, BrowserContext, Playwright

# ── Globals ───────────────────────────────────────────────────────────────────
_playwright: Playwright = None
_browser: Browser = None
_context: BrowserContext = None
_page: Page = None

MODE = "none"   # "cdp" | "native"

DEBUG_PORT = 9222

_CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]
USER_DATA_DIR = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data")

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.15


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_chrome_exe() -> str | None:
    for path in _CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def _is_port_open(port: int = DEBUG_PORT) -> bool:
    try:
        with socket.create_connection(("localhost", port), timeout=1):
            return True
    except OSError:
        return False


def _find_chrome_window():
    """Return the largest visible Chrome window, or None."""
    for title_fragment in ["Google Chrome", "Chrome"]:
        wins = [w for w in gw.getWindowsWithTitle(title_fragment) if w.visible]
        if wins:
            return max(wins, key=lambda w: w.width * w.height)
    return None


def _focus_chrome() -> bool:
    """Bring Chrome to the foreground. Returns True if found."""
    win = _find_chrome_window()
    if not win:
        return False
    try:
        win.activate()
        time.sleep(0.35)
    except Exception:
        pass
    return True


def _chrome_rect():
    """Return (left, top, width, height) of the Chrome window, or None."""
    win = _find_chrome_window()
    if win:
        return win.left, win.top, win.width, win.height
    return None


# ── CDP path ──────────────────────────────────────────────────────────────────

async def _try_cdp_connect(retries: int = 5) -> bool:
    global _browser, _context, _page, MODE
    for attempt in range(1, retries + 1):
        try:
            _browser = await _playwright.chromium.connect_over_cdp(
                f"http://localhost:{DEBUG_PORT}"
            )
            contexts = _browser.contexts
            _context = contexts[0] if contexts else await _browser.new_context()
            pages = _context.pages
            _page = pages[0] if pages else await _context.new_page()
            MODE = "cdp"
            return True
        except Exception as e:
            print(f"  CDP attempt {attempt}/{retries}: {e}")
            if attempt < retries:
                await asyncio.sleep(1.5)
    return False


# ── Startup / shutdown ────────────────────────────────────────────────────────

async def start_browser(headless: bool = False) -> str:
    """Returns active mode: 'cdp' or 'native'."""
    global _playwright, MODE

    _playwright = await async_playwright().start()

    # Step 1: Debug port already open → CDP mode
    if _is_port_open():
        print("✓ Debug port open — connecting via CDP...")
        if await _try_cdp_connect():
            print(f"✓ CDP mode. Active tab: {_page.url}")
            return MODE

    # Step 2: No debug port → Native mode (Chrome stays untouched)
    print("Debug port not open — using Native mode (your Chrome stays as-is).\n")

    if not _find_chrome_window():
        chrome = _get_chrome_exe()
        if chrome:
            print("  Chrome not running — launching it normally...")
            subprocess.Popen(
                [chrome, "--no-first-run", f"--user-data-dir={USER_DATA_DIR}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            time.sleep(3)
        else:
            raise RuntimeError("Could not find chrome.exe. Check _CHROME_CANDIDATES in browser.py.")

    if _find_chrome_window():
        MODE = "native"
        print("✓ Native mode — controlling Chrome via keyboard/mouse + screenshots.")
        print("  Tip: run start_chrome.bat before the agent for full CDP mode.\n")
        return MODE

    raise RuntimeError("Could not find or open Chrome.")


async def stop_browser():
    global _playwright, _browser, _context, _page, MODE
    # CDP: disconnect only — do NOT close the user's Chrome window
    if MODE == "cdp":
        for obj in [_context, _browser]:
            if obj:
                try:
                    await obj.close()
                except Exception:
                    pass
    if _playwright:
        await _playwright.stop()
    _page = _context = _browser = _playwright = None
    MODE = "none"


def get_mode() -> str:
    return MODE


# ── Tools ─────────────────────────────────────────────────────────────────────

async def navigate(url: str) -> dict:
    if not url.startswith("http"):
        url = "https://" + url

    if MODE == "cdp":
        await _page.goto(url, wait_until="domcontentloaded", timeout=15000)
        return {"status": "ok", "url": _page.url, "title": await _page.title()}

    # Native: focus Chrome, open address bar, type, go
    # IMPORTANT: we return the URL we navigated TO, not what's in the bar after load.
    # Reading the address bar mid-load causes incorrect URLs and agent retry loops.
    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)
    pyautogui.hotkey("ctrl", "a")
    pyautogui.write(url, interval=0.03)
    pyautogui.press("enter")
    time.sleep(2.5)  # wait for page to load before returning
    return {"status": "ok", "navigated_to": url, "note": "Page is loading. Use screenshot() to see the result."}


async def click(selector: str = None, text: str = None,
                x: int = None, y: int = None) -> dict:
    if MODE == "cdp":
        if text:
            await _page.get_by_text(text, exact=False).first.click(timeout=8000)
        elif selector:
            await _page.click(selector, timeout=8000)
        else:
            return {"status": "error", "message": "Need selector or text"}
        return {"status": "ok"}

    # Native: MUST have x,y — no DOM access available
    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    if x is not None and y is not None:
        pyautogui.click(x, y)
        time.sleep(0.4)
        return {"status": "ok", "clicked": f"({x}, {y})"}
    return {
        "status": "needs_coords",
        "message": "Call screenshot() first to see the page, then call click(x=X, y=Y) with the coordinates."
    }


async def type_text(selector: str = None, text: str = "",
                    clear_first: bool = True) -> dict:
    if MODE == "cdp":
        if selector and clear_first:
            await _page.fill(selector, "")
        if selector:
            await _page.type(selector, text, delay=40)
        return {"status": "ok"}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    if clear_first:
        pyautogui.hotkey("ctrl", "a")
    pyautogui.write(text, interval=0.04)
    return {"status": "ok"}


async def press_key(key: str) -> dict:
    if MODE == "cdp":
        await _page.keyboard.press(key)
        return {"status": "ok"}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    _KEY_MAP = {
        "Enter": "enter", "Tab": "tab", "Escape": "esc",
        "Backspace": "backspace", "Delete": "delete",
        "ArrowDown": "down", "ArrowUp": "up",
        "ArrowLeft": "left", "ArrowRight": "right",
        "Home": "home", "End": "end",
        "PageDown": "pagedown", "PageUp": "pageup",
    }
    pyautogui.press(_KEY_MAP.get(key, key.lower()))
    return {"status": "ok"}


async def scroll(direction: str = "down", amount: int = 3) -> dict:
    if MODE == "cdp":
        delta = 300 * amount * (1 if direction == "down" else -1)
        await _page.mouse.wheel(0, delta)
        await asyncio.sleep(0.4)
        return {"status": "ok"}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.scroll(-amount * 3 if direction == "down" else amount * 3)
    return {"status": "ok"}


async def scroll_to_bottom() -> dict:
    if MODE == "cdp":
        await _page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(0.5)
        return {"status": "ok"}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.hotkey("ctrl", "end")
    return {"status": "ok"}


async def get_page_text() -> dict:
    if MODE == "cdp":
        text = await _page.inner_text("body")
        return {"status": "ok", "text": text[:6000]}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyperclip.copy("")
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.4)
    pyautogui.press("esc")
    text = pyperclip.paste()
    return {"status": "ok", "text": text[:6000]}


async def get_page_url() -> dict:
    if MODE == "cdp":
        return {"status": "ok", "url": _page.url, "title": await _page.title()}

    # Read address bar — only call this when explicitly needed, not after navigate()
    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)
    pyperclip.copy("")
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.25)
    url = pyperclip.paste().strip()
    pyautogui.press("esc")
    return {"status": "ok", "url": url}


async def screenshot_base64() -> str:
    """Take a screenshot of the Chrome window."""
    if MODE == "cdp":
        img_bytes = await _page.screenshot(type="png")
        return base64.b64encode(img_bytes).decode("utf-8")

    rect = _chrome_rect()
    _focus_chrome()
    time.sleep(0.2)
    if rect:
        left, top, width, height = rect
        img = pyautogui.screenshot(region=(left, top, width, height))
    else:
        img = pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


async def search_web(query: str, engine: str = "google") -> dict:
    engines = {
        "google": f"https://www.google.com/search?q={query.replace(' ', '+')}",
        "bing": f"https://www.bing.com/search?q={query.replace(' ', '+')}",
        "duckduckgo": f"https://duckduckgo.com/?q={query.replace(' ', '+')}",
    }
    return await navigate(engines.get(engine, engines["google"]))


async def open_new_tab(url: str = "about:blank") -> dict:
    global _page
    if MODE == "cdp":
        _page = await _context.new_page()
        if url != "about:blank":
            await navigate(url)
        return {"status": "ok", "message": "New tab opened"}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.hotkey("ctrl", "t")
    time.sleep(0.5)
    if url != "about:blank":
        return await navigate(url)
    return {"status": "ok", "message": "New tab opened"}


async def close_tab() -> dict:
    """Close the current tab."""
    global _page
    if MODE == "cdp":
        try:
            await _page.close()
            # Move to the last remaining page
            pages = _context.pages
            if pages:
                _page = pages[-1]
                await _page.bring_to_front()
                return {"status": "ok", "message": f"Tab closed. Now on: {_page.url}"}
            else:
                _page = await _context.new_page()
                return {"status": "ok", "message": "Tab closed. Opened new blank tab."}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.hotkey("ctrl", "w")
    time.sleep(0.3)
    return {"status": "ok", "message": "Tab closed"}


async def go_back() -> dict:
    if MODE == "cdp":
        await _page.go_back()
        return {"status": "ok"}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.hotkey("alt", "left")
    return {"status": "ok"}


async def go_forward() -> dict:
    if MODE == "cdp":
        await _page.go_forward()
        return {"status": "ok"}

    if not _focus_chrome():
        return {"status": "error", "message": "Chrome window not found"}
    pyautogui.hotkey("alt", "right")
    return {"status": "ok"}


# ── CDP-only tools ────────────────────────────────────────────────────────────

async def wait_for_selector(selector: str, timeout: int = 5000) -> dict:
    if MODE != "cdp":
        return {"status": "error", "message": "CDP-only. Use screenshot() to check if something appeared."}
    try:
        await _page.wait_for_selector(selector, timeout=timeout)
        return {"status": "ok", "found": True}
    except Exception:
        return {"status": "error", "found": False, "message": "Element not found in time"}


async def get_links() -> dict:
    if MODE != "cdp":
        return {"status": "error", "message": "CDP-only. Use screenshot() to see links visually."}
    links = await _page.evaluate("""
        () => Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 30)
            .map(a => ({ text: a.innerText.trim(), href: a.href }))
            .filter(l => l.text.length > 0)
    """)
    return {"status": "ok", "links": links}


# ── Tool registry ─────────────────────────────────────────────────────────────

TOOLS = {
    "navigate": navigate,
    "click": click,
    "type_text": type_text,
    "press_key": press_key,
    "scroll": scroll,
    "scroll_to_bottom": scroll_to_bottom,
    "get_page_text": get_page_text,
    "get_page_url": get_page_url,
    "search_web": search_web,
    "open_new_tab": open_new_tab,
    "close_tab": close_tab,
    "go_back": go_back,
    "go_forward": go_forward,
    "wait_for_selector": wait_for_selector,
    "get_links": get_links,
    "screenshot": screenshot_base64,
}

TOOL_DESCRIPTIONS = """
You have these browser tools. Call them with JSON: {"tool": "navigate", "args": {"url": "https://youtube.com"}}

ALWAYS AVAILABLE (CDP + Native):
- navigate(url)                        Go to a URL. Returns immediately — page may still be loading.
- click(selector?, text?, x?, y?)      CDP: by selector/text. Native: MUST provide x,y pixel coords.
- type_text(text, selector?, clear?)   Type text. Native: click the field first, then type.
- press_key(key)                       Enter, Tab, Escape, ArrowDown, ArrowUp, etc.
- scroll(direction, amount?)           "up" or "down"
- scroll_to_bottom()                   Jump to page bottom
- get_page_text()                      Get visible text on page
- get_page_url()                       Get current URL
- search_web(query, engine?)           Google/Bing/DuckDuckGo search
- open_new_tab(url?)                   Open a new tab
- close_tab()                          Close the current tab (Ctrl+W)
- go_back()                            Navigate back
- go_forward()                         Navigate forward
- screenshot()                         Take a screenshot of Chrome (ALWAYS use this in Native mode to see the page)

CDP MODE ONLY:
- wait_for_selector(selector, ms?)     Wait for an element
- get_links()                          Get all links on page

CRITICAL RULES:
1. After navigate() succeeds, the task of "opening" that site IS DONE. Do NOT navigate again.
2. In Native mode, NEVER use selector or text with click() — always use x,y coordinates.
3. To click something in Native mode: call screenshot() first, identify the element's position, then call click(x=X, y=Y).
4. If navigate() returns status "ok", trust it. Do NOT call get_page_url() to double-check — this disrupts loading.
5. Only call screenshot() when you need to SEE the page. Do not take screenshots unnecessarily.
"""
