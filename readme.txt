# Browser Agent

A local AI browser agent that controls your browser through natural language. Tell it what to do, it figures out the steps and does it.

## What it does

- Controls a real Chromium browser using Playwright
- Uses an LLM to reason about multi-step tasks
- Supports local Ollama models, Ollama Cloud, or external API (OpenAI, Anthropic)
- Clean terminal UI with Rich

## Examples

```
open youtube and play the last video in my history
go to canvas, find my AP Seminar course and open todays agenda
search github for playwright python examples and open the first result
go to google, search for lofi music, click the first youtube result
```

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Install Playwright browsers
playwright install chromium

# 3. Make sure Ollama is running (for local mode)
ollama pull qwen3:4b

# 4. Run
python main.py
```

## Config

On first run just use `/settings` inside the TUI to configure your model source. Settings are saved to `agent_config.json`.

### Modes
| Mode | Description |
|------|-------------|
| `local` | Your own Ollama install, pick any downloaded model |
| `ollama_cloud` | Ollama's cloud API, needs an API key |
| `api` | OpenAI or Anthropic API key |

## Commands

| Command | What it does |
|---------|-------------|
| `/settings` | Change model source and model |
| `/headless` | Toggle visible/headless browser |
| `/url` | Show current browser URL |
| `/clear` | Clear conversation history |
| `/quit` | Exit |

## Project structure

```
browser_agent/
├── main.py          # TUI entry point
├── agent.py         # LLM agent loop
├── browser.py       # Playwright browser tools
├── config.py        # Config load/save
├── requirements.txt
└── README.md
```

## Roadmap

- [ ] Vision support (screenshot → vision model)
- [ ] Bookmark access
- [ ] File system tools
- [ ] History and session replay
- [ ] Electron overlay UI