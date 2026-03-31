"""
config.py — Config load/save + provider model catalogue
"""

import json
import os

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "agent_config.json")

# Model menus shown during setup / /settings
PROVIDER_MODELS = {
    "anthropic": [
        ("claude-haiku-4-5",  "Fastest & cheapest"),
        ("claude-sonnet-4-5", "Balanced · recommended"),
        ("claude-opus-4-5",   "Most capable"),
    ],
    "openai": [
        ("gpt-4o-mini", "Fast & cheap"),
        ("gpt-4o",      "Balanced · recommended"),
        ("gpt-4.1",     "Latest & most capable"),
        ("o4-mini",     "Reasoning model"),
    ],
    "gemini": [
        ("gemini-2.0-flash", "Fastest"),
        ("gemini-1.5-pro",   "Balanced"),
        ("gemini-2.5-pro",   "Most capable"),
    ],
    "openrouter": [
        ("openai/gpt-4o-mini",                  "GPT-4o Mini"),
        ("anthropic/claude-3.5-sonnet",          "Claude 3.5 Sonnet"),
        ("google/gemini-flash-1.5",              "Gemini Flash"),
        ("meta-llama/llama-3.1-70b-instruct",   "Llama 3.1 70B (free tier available)"),
    ],
    "xai": [
        ("grok-3-mini", "Fast & cheap"),
        ("grok-3",      "Most capable"),
    ],
}

DEFAULT_CONFIG = {
    "first_run":      True,
    "mode":           "local",       # "local" | "api"
    "local_model":    "qwen3:4b",
    "api_provider":   "anthropic",   # "anthropic"|"openai"|"gemini"|"openrouter"|"xai"
    "api_key":        "",
    "api_model":      "claude-sonnet-4-5",
    "headless":       False,
    "max_steps":      15,
    "vision_enabled": False,
}


def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            saved = json.load(f)
        # merge so any new keys are always present
        return {**DEFAULT_CONFIG, **saved}
    return DEFAULT_CONFIG.copy()


def save_config(cfg: dict) -> dict:
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)
    return cfg
