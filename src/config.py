from pathlib import Path
import yaml


ROOT = Path(__file__).resolve().parent.parent


# Mỗi provider có default api_file riêng (để dễ tách key Anthropic vs DeepSeek).
PROVIDER_DEFAULT_API_FILE = {
    "anthropic": "API.txt",
    "deepseek": "API_DEEPSEEK.txt",
    "kie": "API_KIE.txt",
    "openai": "API_OPENAI.txt",
}

PROVIDER_DEFAULT_MODEL = {
    "anthropic": "claude-opus-4-7",
    "deepseek": "deepseek-v4-pro",   # Use "deepseek-v4-flash" for cheaper/faster.
    "kie": "gpt-5-6-terra",
    "openai": "gpt-5.6-terra",
}


def _resolve(p: str | None) -> Path | None:
    if not p:
        return None
    path = Path(p)
    return path if path.is_absolute() else (ROOT / path)


def load_config(yaml_path: str) -> dict:
    with open(yaml_path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    # Provider — anthropic (default) hoặc deepseek
    cfg.setdefault("provider", "anthropic")
    if cfg["provider"] not in PROVIDER_DEFAULT_API_FILE:
        raise ValueError(
            f"Unknown provider '{cfg['provider']}'. Supported: {list(PROVIDER_DEFAULT_API_FILE)}"
        )

    # API key file — default theo provider, có thể override.
    cfg.setdefault("api_file", PROVIDER_DEFAULT_API_FILE[cfg["provider"]])

    # Model default theo provider nếu user không set
    default_model = PROVIDER_DEFAULT_MODEL[cfg["provider"]]
    cfg.setdefault("model_training", default_model)
    cfg.setdefault("model_generation", default_model)
    cfg.setdefault("reasoning_effort", "medium")
    cfg.setdefault("processing_mode", "standard")

    # ----- Length config (unit-aware) -----
    # New unified keys: target_length / length_per_part / length_unit.
    # Old keys (target_chars / chars_per_part) kept as aliases for backward compat.
    if "target_length" not in cfg:
        cfg["target_length"] = cfg.get("target_chars", 2000)
    if "length_per_part" not in cfg:
        cfg["length_per_part"] = cfg.get("chars_per_part", 2000)
    cfg.setdefault("length_unit", "auto")   # "auto" | "chars" | "words"

    cfg.setdefault("quantity", 1)
    cfg.setdefault("max_tokens", 8000)
    cfg.setdefault("tts_clean", True)
    cfg.setdefault("length_tolerance", 0.15)
    cfg.setdefault("output_language", None)
    cfg.setdefault("extra_instructions", "")
    cfg.setdefault("training_brief", "")
    cfg.setdefault("refine_mode", "new_only")
    cfg.setdefault("log_requests", True)
    cfg.setdefault("log_dir", "log")
    cfg.setdefault("human_voice", True)
    cfg.setdefault("human_voice_extra", "")
    cfg.setdefault("output_format", "auto")   # "auto" | "off" | "<custom string>"

    for key in (
        "sample_folder",
        "persona_file",
        "output_folder",
        "training_brief_file",
        "viral_sample_file",
        "log_dir",
    ):
        if cfg.get(key):
            cfg[key] = str(_resolve(cfg[key]))

    return cfg


def load_api_keys(api_file: str | Path) -> list[str]:
    path = _resolve(str(api_file)) if not Path(api_file).is_absolute() else Path(api_file)
    if not path.exists():
        raise RuntimeError(f"API key file not found: {path}")
    keys = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            keys.append(line)
    if not keys:
        raise RuntimeError(f"No API keys found in {path}")
    return keys
