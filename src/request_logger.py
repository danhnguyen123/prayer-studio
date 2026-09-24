"""Format API request bodies (messages list) into a readable text log.

Used by generate.py to dump every prompt sent to Claude / DeepSeek so the user
can review what was actually built and shipped.

Format conventions:
- User messages: full text (this is what we want to review).
- Assistant messages (previously-generated parts): truncated to
  "<first 50 chars>...<last 50 chars>" so the log doesn't balloon.
- Content blocks (Anthropic-style list) are expanded with cache_control note.
"""
from __future__ import annotations

DEFAULT_HEAD = 50
DEFAULT_TAIL = 50


def _truncate(text: str, head: int = DEFAULT_HEAD, tail: int = DEFAULT_TAIL) -> str:
    text = text.strip()
    if len(text) <= head + tail + 5:
        return text
    return f"{text[:head]}...{text[-tail:]}"


def _format_block(block) -> str:
    """Format a single content block (dict) or raw string."""
    if isinstance(block, str):
        return block
    if isinstance(block, dict):
        cache = block.get("cache_control")
        text = block.get("text", "")
        if cache:
            return f"[cache_control={cache.get('type','?')}]\n{text}"
        return text
    return str(block)


def _format_content(content, truncate: bool = False) -> str:
    if isinstance(content, str):
        return _truncate(content) if truncate else content
    if isinstance(content, list):
        parts = [_format_block(b) for b in content]
        joined = "\n".join(parts)
        return _truncate(joined) if truncate else joined
    return str(content)


def format_messages(messages: list[dict]) -> str:
    """Format the full messages list into a readable text block."""
    out: list[str] = []
    for i, msg in enumerate(messages, start=1):
        role = msg.get("role", "?")
        truncate = (role == "assistant")
        out.append(f"---- turn {i} [role={role}{' (truncated)' if truncate else ''}] ----")
        out.append(_format_content(msg["content"], truncate=truncate))
        out.append("")
    return "\n".join(out)


def format_request_entry(
    *,
    request_idx: int,
    part_index: int,
    total_parts: int,
    messages: list[dict],
    response_text: str,
    actual_length: int,
    unit_label: str,
    target: int,
    model: str,
    provider: str,
) -> str:
    delta = actual_length - target
    bar = "=" * 80
    sub = "-" * 80
    lines = [
        "",
        bar,
        f" REQUEST {request_idx}  |  Part {part_index}/{total_parts}  |  provider={provider}  model={model}",
        bar,
        format_messages(messages),
        sub,
        f" RESPONSE (truncated)  ({actual_length} {unit_label}, target {target}, delta {delta:+d})",
        sub,
        _truncate(response_text),
        "",
    ]
    return "\n".join(lines)


def format_log_header(
    *,
    script_idx: int,
    total_scripts: int,
    provider: str,
    model: str,
    output_language: str | None,
    unit: str,
    target_total: int,
    window_min: int,
    window_max: int,
    total_parts: int,
    topic: str,
) -> str:
    bar = "#" * 80
    lines = [
        bar,
        f"# Script {script_idx}/{total_scripts}",
        f"# Provider     : {provider}",
        f"# Model        : {model}",
        f"# Output lang  : {output_language or '(persona-decided)'}",
        f"# Length unit  : {unit}",
        f"# Total target : {target_total} {unit} (window {window_min}-{window_max})",
        f"# Parts        : {total_parts}",
        f"# Topic        : {topic}",
        bar,
        "",
    ]
    return "\n".join(lines)


def format_log_footer(*, total_actual: int, unit_label: str, window_min: int, window_max: int) -> str:
    in_band = window_min <= total_actual <= window_max
    flag = "OK" if in_band else "OUT-OF-BAND"
    bar = "#" * 80
    return "\n".join([
        "",
        bar,
        f"# TOTAL: {total_actual} {unit_label}  [{flag}, window {window_min}-{window_max}]",
        bar,
        "",
    ])
