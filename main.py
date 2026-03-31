"""
main.py — TUI entry point for the Browser Agent
Run: python main.py
"""

import asyncio
import sys
from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.prompt import Prompt
from rich.table import Table
from rich.live import Live
from rich.spinner import Spinner
from rich.columns import Columns
from rich import box

from config import load_config, save_config
from browser import start_browser, stop_browser
from agent import run_agent_turn

console = Console()

BANNER = """
██████╗ ██████╗  ██████╗ ██╗    ██╗███████╗███████╗██████╗ 
██╔══██╗██╔══██╗██╔═══██╗██║    ██║██╔════╝██╔════╝██╔══██╗
██████╔╝██████╔╝██║   ██║██║ █╗ ██║███████╗█████╗  ██████╔╝
██╔══██╗██╔══██╗██║   ██║██║███╗██║╚════██║██╔══╝  ██╔══██╗
██████╔╝██║  ██║╚██████╔╝╚███╔███╔╝███████║███████╗██║  ██║
╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝╚═╝  ╚═╝
                    BROWSER AGENT — TUI
"""

HELP_TEXT = """
[bold cyan]Commands:[/bold cyan]
  [yellow]/settings[/yellow]     — change model source and model
  [yellow]/headless[/yellow]     — toggle headless browser mode  
  [yellow]/clear[/yellow]        — clear conversation history
  [yellow]/url[/yellow]          — show current browser URL
  [yellow]/quit[/yellow]         — exit

[bold cyan]Just type anything else[/bold cyan] to give the agent a task.
"""


def print_banner():
    console.print(Text(BANNER, style="bold blue"))
    console.print(Panel(HELP_TEXT, border_style="blue", title="[bold]Quick Help[/bold]"))


def print_config(cfg: dict):
    table = Table(box=box.SIMPLE, show_header=False, border_style="blue")
    table.add_column("Key", style="cyan", width=20)
    table.add_column("Value", style="white")
    table.add_row("Mode", cfg["mode"])
    if cfg["mode"] == "local":
        table.add_row("Model", cfg["local_model"])
    elif cfg["mode"] == "ollama_cloud":
        table.add_row("Model", cfg["ollama_cloud_model"])
        table.add_row("Cloud URL", cfg["ollama_cloud_url"])
    else:
        table.add_row("Provider", cfg["api_provider"])
        table.add_row("Model", cfg["api_model"])
    table.add_row("Headless", str(cfg["headless"]))
    console.print(Panel(table, title="[bold blue]Current Config[/bold blue]", border_style="blue"))


def settings_menu(cfg: dict) -> dict:
    console.print("\n[bold cyan]Settings[/bold cyan]\n")

    mode = Prompt.ask(
        "Mode",
        choices=["local", "ollama_cloud", "api"],
        default=cfg["mode"]
    )
    cfg["mode"] = mode

    if mode == "local":
        model = Prompt.ask("Local model name", default=cfg["local_model"])
        cfg["local_model"] = model

    elif mode == "ollama_cloud":
        model = Prompt.ask("Cloud model name", default=cfg["ollama_cloud_model"])
        cfg["ollama_cloud_model"] = model
        url = Prompt.ask("Ollama Cloud URL", default=cfg["ollama_cloud_url"])
        cfg["ollama_cloud_url"] = url
        key = Prompt.ask("API Key", password=True, default=cfg["ollama_cloud_key"] or "")
        cfg["ollama_cloud_key"] = key

    elif mode == "api":
        provider = Prompt.ask("Provider", choices=["openai", "anthropic"], default=cfg["api_provider"])
        cfg["api_provider"] = provider
        model = Prompt.ask("Model name", default=cfg["api_model"])
        cfg["api_model"] = model
        key = Prompt.ask("API Key", password=True, default=cfg["api_key"] or "")
        cfg["api_key"] = key

    save_config(cfg)
    console.print("[green]✓ Settings saved[/green]\n")
    return cfg


async def main():
    print_banner()

    cfg = load_config()
    print_config(cfg)

    # start browser
    console.print("[blue]Starting browser...[/blue]")
    await start_browser(headless=cfg["headless"])
    console.print("[green]✓ Browser ready[/green]\n")

    history = []

    while True:
        try:
            user_input = Prompt.ask("\n[bold blue]You[/bold blue]").strip()
        except (KeyboardInterrupt, EOFError):
            break

        if not user_input:
            continue

        # ─── Commands ───
        if user_input == "/quit":
            break

        if user_input == "/clear":
            history = []
            console.print("[yellow]History cleared[/yellow]")
            continue

        if user_input == "/settings":
            cfg = settings_menu(cfg)
            print_config(cfg)
            continue

        if user_input == "/headless":
            cfg["headless"] = not cfg["headless"]
            save_config(cfg)
            console.print(f"[yellow]Headless: {cfg['headless']} (restart to apply)[/yellow]")
            continue

        if user_input == "/url":
            from browser import get_page_url
            result = await get_page_url()
            console.print(f"[cyan]{result['url']}[/cyan] — {result.get('title', '')}")
            continue

        if user_input == "/help":
            console.print(Panel(HELP_TEXT, border_style="blue"))
            continue

        # ─── Agent task ───
        status_msg = ["Thinking..."]

        def update_status(msg: str):
            status_msg[0] = msg

        # show spinner while agent works
        with Live(
            Spinner("dots", text=Text(status_msg[0], style="blue")),
            console=console,
            refresh_per_second=10,
            transient=True
        ) as live:
            async def run_with_live():
                def cb(msg):
                    update_status(msg)
                    live.update(Spinner("dots", text=Text(msg, style="blue")))

                return await run_agent_turn(user_input, history, status_cb=cb)

            reply, history = await run_with_live()

        console.print(
            Panel(
                Text(reply, style="white"),
                title="[bold blue]Agent[/bold blue]",
                border_style="blue"
            )
        )

    # cleanup
    console.print("\n[blue]Shutting down...[/blue]")
    await stop_browser()
    console.print("[green]Bye.[/green]")


if __name__ == "__main__":
    asyncio.run(main())