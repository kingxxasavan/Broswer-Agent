"""
browser.py — Playwright browser control layer
Auto connects to running Chrome or relaunches it with debug port.
"""

import asyncio
import base64
import socket
import subprocess
import time
import os
from playwright.async_api import async_playwright, Page, Browser, BrowserContext

_playwright = None
_browser: Browser = None
_context: BrowserContext = None
_page: Page = None

DEBUG_PORT = 9222
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


def _is_debug_port_open() -> bool:
    try:
        with socket.create_connection(("localhost", DEBUG_PORT), timeout=1):
            return True
    except OSError:
        return False


def _kill_and_relaunch_chrome():
    """Blocking: kill Chrome and relaunch with debug port. Run in executor."""
    user_data_dir = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data")

    # Kill existing Chrome
    subprocess.run(
        ["taskkill", "/F", "/IM", "chrome.exe"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    time.sleep(2)

    # Relaunch with debug port
    subprocess.Popen([
        CHROME_PATH,
        f"--remote-debugging-port={DEBUG_PORT}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Wait for port to open (up to 10 seconds)
    for _ in range(20):
        if _is_debug_port_open():
            return True
        time.sleep(0.5)

    return False


async def start_browser(headless: bool = False):
    global _playwright, _browser, _context, _page

    _playwright = await async_playwright().start()

    if not _is_debug_port_open():
        print("Chrome not in debug mode. Relaunching...")
        # Run the blocking kill+relaunch in a thread so asyncio doesn't freeze
        loop = asyncio.get_event_loop()
        ready = await loop.run_in_executor(None, _kill_and_relaunch_chrome)
        if not ready:
            print("Chrome launch timed out. Falling back to fresh browser...")
            _browser = await _playwright.chromium.launch(headless=headless)
            _context = await _browser.new_context(viewport={"width": 1280, "height": 800})
            _page = await _context.new_page()
            return _page
        print("Chrome ready, connecting...")
    else:
        print("Connecting to existing Chrome...")

    try:
        _browser = await _playwright.chromium.connect_over_cdp(f"http://localhost:{DEBUG_PORT}")
        contexts = _browser.contexts
        _context = contexts[0] if contexts else await _browser.new_context()
        pages = _context.pages
        _page = pages[0] if pages else await _context.new_page()
    except Exception as e:
        print(f"CDP connect failed: {e}\nFalling back to fresh browser...")
        _browser = await _playwright.chromium.launch(headless=headless)
        _context = await _browser.new_context(viewport={"width": 1280, "height": 800})
        _page = await _context.new_page()

    return _page


async def stop_browser():
    global _playwright, _context, _browser
    for obj in [_context, _browser]:
        if obj:
            try:
                await obj.close()
            except Exception:
                pass
    if _playwright:
        await _playwright.stop()


async def get_page() -> Page:
    if _page is None:
        raise RuntimeError("Browser not started.")
    return _page


async def navigate(url: str) -> dict:
    page = await get_page()
    if not url.startswith("http"):
        url = "https://" + url
    await page.goto(url, wait_until="domcontentloaded", timeout=15000)
    return {"status": "ok", "url": page.url, "title": await page.title()}


async def click(selector: str = None, text: str = None) -> dict:
    page = await get_page()
    if text:
        await page.get_by_text(text, exact=False).first.click(timeout=8000)
    elif selector:
        await page.click(selector, timeout=8000)
    else:
        return {"status": "error", "message": "Need selector or text"}
    return {"status": "ok"}


async def type_text(selector: str, text: str, clear_first: bool = True) -> dict:
    page = await get_page()
    if clear_first:
        await page.fill(selector, "")
    await page.type(selector, text, delay=40)
    return {"status": "ok"}


async def press_key(key: str) -> dict:
    page = await get_page()
    await page.keyboard.press(key)
    return {"status": "ok"}


async def scroll(direction: str = "down", amount: int = 3) -> dict:
    page = await get_page()
    delta = 300 * amount
    if direction == "up":
        delta = -delta
    await page.mouse.wheel(0, delta)
    await asyncio.sleep(0.4)
    return {"status": "ok"}


async def scroll_to_bottom() -> dict:
    page = await get_page()
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await asyncio.sleep(0.5)
    return {"status": "ok"}


async def get_page_text() -> dict:
    page = await get_page()
    text = await page.inner_text("body")
    return {"status": "ok", "text": text[:6000]}


async def get_page_url() -> dict:
    page = await get_page()
    return {"status": "ok", "url": page.url, "title": await page.title()}


async def screenshot_base64() -> str:
    page = await get_page()
    img_bytes = await page.screenshot(type="png")
    return base64.b64encode(img_bytes).decode("utf-8")


async def search_web(query: str, engine: str = "google") -> dict:
    engines = {
        "google": f"https://www.google.com/search?q={query.replace(' ', '+')}",
        "bing": f"https://www.bing.com/search?q={query.replace(' ', '+')}",
        "duckduckgo": f"https://duckduckgo.com/?q={query.replace(' ', '+')}",
    }
    return await navigate(engines.get(engine, engines["google"]))


async def open_new_tab(url: str = "about:blank") -> dict:
    global _page
    _page = await _context.new_page()
    if url != "about:blank":
        await navigate(url)
    return {"status": "ok", "message": "New tab opened"}


async def go_back() -> dict:
    page = await get_page()
    await page.go_back()
    return {"status": "ok"}


async def wait_for_selector(selector: str, timeout: int = 5000) -> dict:
    page = await get_page()
    try:
        await page.wait_for_selector(selector, timeout=timeout)
        return {"status": "ok", "found": True}
    except Exception:
        return {"status": "error", "found": False, "message": "Element not found in time"}


async def get_links() -> dict:
    page = await get_page()
    links = await page.evaluate("""
        () => Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 30)
            .map(a => ({ text: a.innerText.trim(), href: a.href }))
            .filter(l => l.text.length > 0)
    """)
    return {"status": "ok", "links": links}


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
    "go_back": go_back,
    "wait_for_selector": wait_for_selector,
    "get_links": get_links,
    "screenshot": screenshot_base64,
}

TOOL_DESCRIPTIONS = """
You have these browser tools available. Call them using JSON like: {"tool": "navigate", "args": {"url": "https://youtube.com"}}

- navigate(url): Go to a URL
- click(selector?, text?): Click an element by CSS selector or by visible text
- type_text(selector, text, clear_first?): Type into an input field
- press_key(key): Press a key like Enter, Tab, Escape
- scroll(direction, amount?): Scroll "up" or "down" by amount steps
- scroll_to_bottom(): Scroll to the very bottom of the page
- get_page_text(): Get visible text on the current page
- get_page_url(): Get current URL and title
- search_web(query, engine?): Search Google/Bing/DuckDuckGo
- open_new_tab(url?): Open a new browser tab
- go_back(): Go back in browser history
- wait_for_selector(selector, timeout?): Wait for an element to appear
- get_links(): Get clickable links on current page
- screenshot(): Take a screenshot (use when you need to see the page)
"""