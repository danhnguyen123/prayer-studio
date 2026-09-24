"""Writer Pro — Python edition. Supports Anthropic (Claude) and DeepSeek providers.

Usage:
  python run.py train    --config configs/example.yaml
  python run.py generate --config configs/example.yaml
  python run.py all      --config configs/example.yaml
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from src.ai_client import BaseClient, make_client
from src.config import load_api_keys, load_config
from src.generate import generate
from src.train import train


def _make_client(cfg: dict, phase: str) -> BaseClient:
    environment_key = {
        "openai": "OPENAI_API_KEY",
        "kie": "KIE_API_KEY",
    }.get(cfg["provider"])
    if environment_key and os.environ.get(environment_key, "").strip():
        keys = [os.environ[environment_key].strip()]
    else:
        keys = load_api_keys(cfg["api_file"])
    model = cfg["model_training"] if phase == "train" else cfg["model_generation"]
    return make_client(
        provider=cfg["provider"],
        api_keys=keys,
        default_model=model,
        reasoning_effort=cfg.get("reasoning_effort", "medium"),
        processing_mode=cfg.get("processing_mode", "standard"),
    )


def cmd_train(cfg: dict):
    client = _make_client(cfg, "train")
    train(cfg, client)


def cmd_generate(cfg: dict):
    client = _make_client(cfg, "generate")
    generate(cfg, client)


def cmd_all(cfg: dict):
    persona_path = Path(cfg["persona_file"])
    if not persona_path.exists() or persona_path.stat().st_size == 0:
        cmd_train(cfg)
    else:
        print(f"[all] Persona already exists: {persona_path.name} — skipping training.")
    cmd_generate(cfg)


def main():
    parser = argparse.ArgumentParser(prog="writer-pro")
    parser.add_argument("command", choices=["train", "generate", "all"])
    parser.add_argument("--config", required=True, help="Path to YAML config")
    parser.add_argument(
        "--processing-mode",
        choices=["standard", "batch"],
        help="Override OpenAI processing mode for this run",
    )
    parser.add_argument(
        "--provider",
        choices=["openai", "kie"],
        help="Override GPT provider for this run",
    )
    args = parser.parse_args()

    cfg = load_config(args.config)
    if args.processing_mode:
        cfg["processing_mode"] = args.processing_mode
    if args.provider:
        cfg["provider"] = args.provider
        if args.provider == "kie":
            cfg["api_file"] = "API_KIE.txt"
    print(f"[run] Loaded config: {args.config}")
    print(f"[run] Project: {cfg.get('name', '(unnamed)')}")
    print(f"[run] Provider: {cfg['provider']} | api_file: {cfg['api_file']}")
    print(f"[run] Models: train={cfg['model_training']}  generate={cfg['model_generation']}")

    if args.command == "train":
        cmd_train(cfg)
    elif args.command == "generate":
        cmd_generate(cfg)
    else:
        cmd_all(cfg)


if __name__ == "__main__":
    sys.exit(main())
