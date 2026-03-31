"""
main.py — TUI entry point for Browser Agent.

First-time launch → guided setup wizard.
Subsequent launches → load saved config and go.
"""

import asyncio
import httpx
from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.prompt import Prompt
from rich.table import Table
from rich.live import Live
from rich.spinner import Spinner
from rich import box

from config import load_config, save_config, PROVIDER_MODELS
from browser import start_browser, stop_browser, get_page_url
from agent import run_agent_turn

console = Console()

BANNER = r"""
 ██████╗ ██████╗  ██████╗ ██╗    ██╗███████╗███████╗██████╗ 
 ██╔══██╗██╔══██╗██╔═══██╗██║    ██║██╔════╝██╔════╝██╔══██╗
 ██████╔╝██████╔╝██║   ██║██║ █╗ ██║███████╗█████╗  ██████╔╝
 ██╔══██╗██╔══██╗██║   ██║██║███╗██║╚════██║██╔══╝  ██╔══██╗
 ██████╔╝██║  ██║╚██████╔╝╚███╔███╔╝███████║███████╗██║  ██║
 ╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝╚═╝  ╚═╝
               BROWSER AGENT  ·  local AI  ·  real browser
"""

HELP_TEXT = """\
[bold cyan]Commands[/bold cyan]
[yellow]/settings[/yellow]  — change model or provider
[yellow]/headless[/yellow]  — toggle headless browser
[yellow]/vision[/yellow]    — toggle screenshot analysis
[yellow]/clear[/yellow]     — wipe conversation history
[yellow]/url[/yellow]       — show current browser URL
[yellow]/help[/yellow]      — show this menu
[yellow]/quit[/yellow]      — exit

Type anything else to give the agent a task.\
"""


# ── UI helpers ─────────────────────────────────────────────

def print_banner():
    console.print(Text(BANNER, style="bold blue"))
    console.print(Panel(HELP_TEXT, border_style="blue", title="[bold]Quick Help[/bold]"))


def print_config(cfg: dict):
    table = Table(box=box.SIMPLE, show_header=False, border_style="blue")
    table.add_column("Key",   style="cyan",  width=16)
    table.add_column("Value", style="white")

    if cfg["mode"] == "local":
        table.add_row("Mode",  "Local (Ollama)")
        table.add_row("Model", cfg["local_model"])
    else:
        table.add_row("Mode",     f"API — {cfg['api_provider'].upper()}")
        table.add_row("Model",    cfg["api_model"])
        masked = ("•" * 8 + cfg["api_key"][-4:]) if len(cfg["api_key"]) > 4 else "[red]not set[/red]"
        table.add_row("Key",      masked)

    table.add_row("Headless",  str(cfg["headless"]))
    table.add_row("Vision",    "[green]on[/green]" if cfg.get("vision_enabled") else "[dim]off[/dim]")
    table.add_row("Max steps", str(cfg.get("max_steps", 15)))

    console.print(Panel(table, title="[bold blue]Active Config[/bold blue]", border_style="blue"))


# ── Ollama model fetcher ───────────────────────────────────

async def _fetch_ollama_models() -> list[dict]:
    """Ask local Ollama for installed models (name + size)."""
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get("http://localhost:11434/api/tags", timeout=5)
            return r.json().get("models", [])
    except Exception:
        return []


# ── First-run wizard ───────────────────────────────────────

async def first_run_wizard() -> dict:
    cfg = load_config()

    console.print("\n[bold blue]━━━━━━━━━  Welcome to Browser Agent!  ━━━━━━━━━[/bold blue]")
    console.print("Let's get you set up. This only runs once.\n")

    # ── Step 1: Local or API? ──────────────────────────────
    console.print("[bold]How do you want to run the AI brain?[/bold]\n")
    console.print("  [yellow]1[/yellow].  [bold]Local[/bold]  — Ollama on your machine  "
                  "[dim](free · private · no internet needed)[/dim]")
    console.print("  [yellow]2[/yellow].  [bold]API[/bold]    — Cloud provider          "
                  "[dim](needs API key · smarter models available)[/dim]\n")

    mode_choice = ""
    while mode_choice not in ("1", "2"):
        mode_choice = Prompt.ask("Your choice", choices=["1", "2"])

    # ══════════════════════════════════════════════════════
    if mode_choice == "1":
        # ── LOCAL / OLLAMA ─────────────────────────────────
        cfg["mode"] = "local"
        console.print("\n[blue]Checking Ollama for installed models...[/blue]")
        models = await _fetch_ollama_models()

        if models:
            console.print(f"\n[bold cyan]Your installed Ollama models[/bold cyan] "
                          f"[dim]({len(models)} found)[/dim]\n")
            console.print("  [dim]💡 8 GB RAM → pick a 3B–4B model   "
                          "16 GB RAM → 7B is fine   32 GB+ → go bigger[/dim]\n")

            # Build numbered display
            names: list[str] = []
            for i, m in enumerate(models, 1):
                name      = m.get("name", "?")
                size_gb   = m.get("size", 0) / (1024 ** 3)
                tag_color = "green" if size_gb < 3 else ("yellow" if size_gb < 6 else "red")
                console.print(
                    f"  [yellow]{i:>2}[/yellow].  [white]{name:<30}[/white]  "
                    f"[{tag_color}]{size_gb:.1f} GB[/{tag_color}]"
                )
                names.append(name)

            console.print(f"\n  [yellow]{len(names)+1:>2}[/yellow].  Enter a different model name")
            console.print()

            while True:
                raw = Prompt.ask("Pick a model (number or name)").strip()
                if raw.isdigit():
                    idx = int(raw) - 1
                    if idx == len(names):
                        cfg["local_model"] = Prompt.ask("Model name (e.g. llama3.2:3b)").strip()
                        break
                    elif 0 <= idx < len(names):
                        cfg["local_model"] = names[idx]
                        break
                elif raw:
                    cfg["local_model"] = raw
                    break
                console.print("[red]Invalid — enter a number or model name[/red]")

        else:
            console.print("[yellow]⚠  Could not reach Ollama (is it running?)[/yellow]")
            console.print("Enter a model name now; make sure Ollama is running before using the agent.\n")
            cfg["local_model"] = Prompt.ask("Model name", default="qwen3:4b").strip()

        console.print(f"\n[green]✓ Local model set:[/green] [bold]{cfg['local_model']}[/bold]")

    # ══════════════════════════════════════════════════════
    else:
        # ── API PROVIDER ───────────────────────────────────
        cfg["mode"] = "api"

        providers = [
            ("anthropic",  "Anthropic  — Claude   [dim](claude-sonnet-4-5 recommended)[/dim]"),
            ("openai",     "OpenAI     — GPT      [dim](gpt-4o recommended)[/dim]"),
            ("gemini",     "Google     — Gemini   [dim](gemini-2.0-flash recommended)[/dim]"),
            ("openrouter", "OpenRouter — multi-model hub [dim](free tier available)[/dim]"),
            ("xai",        "xAI        — Grok     [dim](grok-3-mini recommended)[/dim]"),
        ]
        provider_keys   = [p[0] for p in providers]
        provider_labels = [p[1] for p in providers]

        console.print("\n[bold cyan]Choose your API provider[/bold cyan]\n")
        for i, label in enumerate(provider_labels, 1):
            console.print(f"  [yellow]{i}[/yellow].  {label}")

        while True:
            raw = Prompt.ask("\nYour choice").strip()
            if raw.isdigit() and 1 <= int(raw) <= len(providers):
                cfg["api_provider"] = provider_keys[int(raw) - 1]
                break
            console.print("[red]Enter a number 1–5[/red]")

        provider = cfg["api_provider"]
        console.print(f"\n[green]✓ Provider:[/green] [bold]{provider.upper()}[/bold]")

        # API key
        key_urls = {
            "anthropic":  "https://console.anthropic.com/",
            "openai":     "https://platform.openai.com/api-keys",
            "gemini":     "https://aistudio.google.com/app/apikey",
            "openrouter": "https://openrouter.ai/keys",
            "xai":        "https://console.x.ai/",
        }
        console.print(f"\n[dim]Get your API key at → [blue underline]{key_urls[provider]}[/blue underline][/dim]\n")
        cfg["api_key"] = Prompt.ask("Paste your API key", password=True).strip()

        # Model selection
        model_list = PROVIDER_MODELS.get(provider, [])
        if model_list:
            console.print(f"\n[bold cyan]Available {provider.upper()} models[/bold cyan]\n")
            model_names = [m[0] for m in model_list]

            for i, (name, desc) in enumerate(model_list, 1):
                console.print(f"  [yellow]{i}[/yellow].  [white]{name:<45}[/white] [dim]{desc}[/dim]")
            console.print(f"  [yellow]{len(model_names)+1}[/yellow].  Enter a custom model name\n")

            while True:
                raw = Prompt.ask("Pick a model").strip()
                if raw.isdigit():
                    idx = int(raw) - 1
                    if idx == len(model_names):
                        cfg["api_model"] = Prompt.ask("Custom model name").strip()
                        break
                    elif 0 <= idx < len(model_names):
                        cfg["api_model"] = model_names[idx]
                        break
                elif raw:
                    cfg["api_model"] = raw
                    break
                console.print("[red]Invalid[/red]")
        else:
            cfg["api_model"] = Prompt.ask("Model name").strip()

        console.print(f"\n[green]✓ Model:[/green] [bold]{cfg['api_model']}[/bold]")

    # ── Vision ─────────────────────────────────────────────
    console.print("\n[bold]Enable vision? (screenshot analysis)[/bold]")
    console.print("  [dim]Requires a vision-capable model "
                  "(llava · claude · gpt-4o · gemini · grok-3)[/dim]")
    cfg["vision_enabled"] = Prompt.ask("Enable vision?", choices=["y", "n"], default="n") == "y"

    # ── Headless ───────────────────────────────────────────
    cfg["headless"] = Prompt.ask(
        "Hide the browser window (headless)?", choices=["y", "n"], default="n"
    ) == "y"

    # ── Max steps ──────────────────────────────────────────
    raw_steps = Prompt.ask("Max agent steps per task", default="15").strip()
    cfg["max_steps"] = int(raw_steps) if raw_steps.isdigit() else 15

    cfg["first_run"] = False
    save_config(cfg)
    console.print("\n[bold green]✓ Setup complete! Config saved to agent_config.json[/bold green]\n")
    return cfg


# ── Settings menu (re-run for existing users) ──────────────

async def settings_menu(cfg: dict) -> dict:
    console.print("\n[bold cyan]Settings[/bold cyan]\n")
    console.print("  [yellow]1[/yellow].  Change model / provider  [dim](re-run setup)[/dim]")
    console.print("  [yellow]2[/yellow].  Toggle vision")
    console.print("  [yellow]3[/yellow].  Toggle headless")
    console.print("  [yellow]4[/yellow].  Change max steps")
    console.print("  [yellow]5[/yellow].  Cancel\n")

    choice = Prompt.ask("Choice", choices=["1", "2", "3", "4", "5"], default="5")

    if choice == "1":
        cfg["first_run"] = True
        cfg = await first_run_wizard()

    elif choice == "2":
        cfg["vision_enabled"] = not cfg.get("vision_enabled", False)
        state = "[green]on[/green]" if cfg["vision_enabled"] else "[dim]off[/dim]"
        console.print(f"Vision: {state}")
        save_config(cfg)

    elif choice == "3":
        cfg["headless"] = not cfg["headless"]
        console.print(f"[yellow]Headless: {cfg['headless']}  (restart to apply)[/yellow]")
        save_config(cfg)

    elif choice == "4":
        raw = Prompt.ask("Max steps", default=str(cfg.get("max_steps", 15))).strip()
        cfg["max_steps"] = int(raw) if raw.isdigit() else 15
        save_config(cfg)
        console.print(f"[green]Max steps → {cfg['max_steps']}[/green]")

    return cfg


# ── Main loop ───────────────────────────────────────────────

async def main():
    print_banner()
    cfg = load_config()

    # First launch → wizard
    if cfg.get("first_run", True):
        cfg = await first_run_wizard()

    print_config(cfg)

    console.print("[blue]Starting browser...[/blue]")
    await start_browser(headless=cfg["headless"])
    console.print("[green]✓ Browser ready[/green]\n")

    history: list = []

    while True:
        try:
            user_input = Prompt.ask("\n[bold blue]You[/bold blue]").strip()
        except (KeyboardInterrupt, EOFError):
            break

        if not user_input:
            continue

        # ── Built-in commands ──────────────────────────────
        match user_input:
            case "/quit":
                break

            case "/clear":
                history = []
                console.print("[yellow]History cleared[/yellow]")

            case "/settings":
                cfg = await settings_menu(cfg)
                print_config(cfg)

            case "/headless":
                cfg["headless"] = not cfg["headless"]
                save_config(cfg)
                console.print(f"[yellow]Headless: {cfg['headless']}  (restart to apply)[/yellow]")

            case "/vision":
                cfg["vision_enabled"] = not cfg.get("vision_enabled", False)
                save_config(cfg)
                state = "[green]on[/green]" if cfg["vision_enabled"] else "[dim]off[/dim]"
                console.print(f"Vision: {state}")

            case "/url":
                result = await get_page_url()
                console.print(f"[cyan]{result['url']}[/cyan]  {result.get('title', '')}")

            case "/help":
                console.print(Panel(HELP_TEXT, border_style="blue"))

            case _:
                # ── Agent task ─────────────────────────────
                status_msg = ["Thinking..."]

                with Live(
                    Spinner("dots", text=Text(status_msg[0], style="blue")),
                    console=console,
                    refresh_per_second=10,
                    transient=True,
                ) as live:
                    async def run_with_live():
                        def cb(msg: str):
                            status_msg[0] = msg
                            live.update(Spinner("dots", text=Text(msg, style="blue")))
                        return await run_agent_turn(user_input, history, status_cb=cb)

                    reply, history = await run_with_live()

                console.print(
                    Panel(
                        Text(reply, style="white"),
                        title="[bold blue]Agent[/bold blue]",
                        border_style="blue",
                    )
                )

    console.print("\n[blue]Shutting down...[/blue]")
    await stop_browser()
    console.print("[green]Bye.[/green]")


if __name__ == "__main__":
    asyncio.run(main())
