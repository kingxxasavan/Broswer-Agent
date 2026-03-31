import json
import os

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "agent_config.json")

DEFAULT_CONFIG = {
    "mode": "local",           # "local" | "ollama_cloud" | "api"
    "local_model": "qwen3.5:4b",
    "ollama_cloud_model": "qwen2.5:72b",
    "ollama_cloud_url": "https://api.ollama.com",
    "ollama_cloud_key": "",
    "api_provider": "openai",  # "openai" | "anthropic" | "google"
    "api_key": "",
    "api_model": "gpt-4o",
    "headless": False,         # show browser window or not
    "screenshot_on_action": True,
}


def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            saved = json.load(f)
        # merge with defaults so new keys always exist
        return {**DEFAULT_CONFIG, **saved}
    return DEFAULT_CONFIG.copy()


def save_config(cfg: dict):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)
    return cfg