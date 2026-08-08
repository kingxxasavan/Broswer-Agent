# Browser Agent

A Chrome extension that hands your browser to an AI. You type what you want in a
side panel; it reads the page, clicks things, fills in fields, moves between
tabs and downloads files to your computer — in your real browser, with your real
logins.

```
"Find the pricing page and tell me the cheapest paid plan."
"Search this site for annual reports and download the 2024 PDF."
"Open my orders and list everything that shipped this week."
"Go to the docs, find the rate limits section, and summarise it."
```

## Install

No build required — the bundled service worker is committed.

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. Click the extension icon to open the side panel, then **Settings**.
5. Choose a provider, paste an API key, and save.

Works in Chrome 116+ and Chromium-based browsers with side-panel support (Edge,
Brave, Arc).

## Providers

| Provider | Notes |
| --- | --- |
| **Anthropic (Claude)** | Default. Uses the official SDK; `claude-opus-5` out of the box. |
| OpenAI | `gpt-4.1`, `gpt-4o`, … |
| Google Gemini | `gemini-2.0-flash`, `gemini-1.5-pro` |
| OpenRouter / Groq / xAI | OpenAI-compatible endpoints |
| Ollama | Local models — needs one that supports tool calling |
| Custom | Any OpenAI-compatible `/chat/completions` endpoint |

Whatever model you pick **must support tool calling**. The key is stored in
`chrome.storage.local`, so it stays in this browser profile and is sent only to
the provider you chose.

## What it can do

| | |
| --- | --- |
| Read | `read_page` — URL, title, every interactive element with an index, and the page text (including same-origin iframes and open shadow DOM) |
| Act | `click`, `type_text`, `press_key`, `scroll`, `scroll_to_element`, `navigate`, `go_back`, `wait` |
| Tabs | `list_tabs`, `open_tab`, `switch_tab`, `close_tab` |
| Files | `download_url`, `download_element`, `list_downloads` |
| See | `screenshot` — off by default; enable it in settings |

The page is described to the model as an indexed list, so it acts on real
elements rather than guessing at coordinates:

```
[4] <input type=search placeholder="Search products"> ""
[5] <button> "Search"
[6] <a href="/report.pdf" download> "Annual report"
```

Every action that changes the page returns a fresh snapshot with it, so the
model always works from current indices.

## Staying in control

- **Stop** ends a run at the next step.
- **Ask me before every action** (settings) puts an Allow/Skip prompt in the
  panel before each click, keystroke and download.
- **Blocked sites** (settings) is a list of hostnames — your bank, an admin
  console — that every tool refuses to touch, subdomains included.
- **Step limit** caps how many actions one request may take before the agent
  stops and checks in.
- The agent is told not to enter passwords or one-time codes, and to stop and
  ask before anything hard to undo (buying, sending, posting, deleting).

Worth knowing: page text and links from the tab it's working in are sent to your
AI provider, and screenshots too if you enable them. Chrome blocks all
extensions on `chrome://` pages and the Web Store, so the agent cannot see or
touch those.

## Right-click shortcuts

- **Ask Browser Agent about this page**
- **Ask Browser Agent about "…"** on a selection
- **Download this link with Browser Agent** on a link

## Development

```bash
npm install
npm run build     # bundle src/background -> dist/background.js
npm run watch     # rebuild on save (then hit Reload in chrome://extensions)
npm run smoke     # load the extension in Chromium and test it for real
npm run icons     # regenerate icons/ from tools/make_icons.py
```

`npm run smoke` launches Chromium with the extension loaded and checks the parts
that have to be right before any prompt can work: snapshots, clicking (including
inside iframes), typing into framework-managed fields, scrolling, downloads
landing on disk, the blocked-sites guard, and a full agent loop driven by a mock
provider in both the Anthropic and OpenAI wire formats. No API key needed. If
Playwright's bundled Chromium isn't the one you want, set `CHROMIUM_PATH`.

Only the service worker is bundled — the content script, side panel and options
page load as plain files, so you can edit them and just reload the extension.

### Layout

```
manifest.json
dist/background.js          bundled service worker (committed, rebuild with npm run build)
src/
  background/
    index.js                entry: side panel port, context menus, wiring
    agent.js                the ask -> act -> feed back loop
    tools.js                tool definitions and their implementations
    browser.js              tabs, frames, snapshots, element index mapping
    prompt.js               system prompt
    llm/                    anthropic.js (SDK), openai.js, gemini.js
  content/content.js        reads and drives the page, one copy per frame
  sidepanel/                chat UI
  options/                  settings
tools/
  smoke-test.mjs            end-to-end test in real Chromium
  make_icons.py             icon generator (stdlib only)
```

## Limitations

- No `chrome://` pages, the Chrome Web Store, or other extensions' pages —
  Chrome forbids it.
- Cross-origin iframes are only reachable where Chrome lets the content script
  in; a frame it cannot enter is skipped.
- Canvas- and WebGL-rendered UIs have no DOM to read. Turn on screenshots and
  the model can at least look at them.
- Sites with aggressive bot detection may block automated interaction.
- The agent does not solve CAPTCHAs or enter credentials. Log in yourself first;
  it works within your existing session.

## License

CC0 1.0 Universal — see [LICENSE](LICENSE).
