from __future__ import annotations

import math
from datetime import datetime
from pathlib import Path

from .ai_client import BaseClient, text_block
from .human_voice import get_human_voice_rules
from .output_format import get_output_format
from .request_logger import (
    format_log_footer,
    format_log_header,
    format_request_entry,
)


TTS_CLEAN_RULE = """
- Do NOT use lists, bullet points, comments, markdown, code blocks or explanations.
- Output ONLY narration suitable for a text-to-speech engine. Remove all non-narration text, including speaker labels, timestamps, stage directions, and notes.
""".strip()


_DEFAULT_REQ_TEMPLATE = """Dựa vào Persona DNA của writer bên trên (Style, Tone, Focus, Target Audience, Hook Pattern, Pacing, Emotional Arc, Closing Pattern, POV...), hãy CHỈ HỌC theo: Giọng văn (Tone), Cấu trúc câu và Nhịp điệu kể chuyện.
⛔ TUYỆT ĐỐI KHÔNG được sao chép lại nội dung, tên nhân vật hay bối cảnh của bất kỳ sample nào.
Nhiệm vụ: Hãy sáng tạo ra 1 kịch bản HOÀN TOÀN MỚI về chủ đề: [Điền Chủ Đề Của Bạn Vào Đây].
Yêu cầu bắt buộc:
1. Bối cảnh và Nhân vật phải mới lạ.
2. Tình tiết không được trùng lặp với các bài mẫu.
3. Mỗi câu chuyện phải có Plot Twist / cú quay xe / emotional turning point đặc trưng cho persona này.
4. Tuân thủ NGHIÊM NGẶT mọi rule trong mục Do / Don't của Persona DNA."""


# --- Length unit handling --------------------------------------------------

# Languages where characters are the natural unit (1 char ≈ 1 morpheme).
# Substrings checked case-insensitively against output_language.
_CJK_LANG_HINTS = (
    "japanese", "nhật", "日本", "日語",
    "chinese", "trung", "中文", "中国",
    "korean", "hàn", "한국", "韩语",
)

_LANGUAGE_CJK = {
    "japanese": "Japanese Hiragana/Katakana/Kanji",
    "chinese": "Chinese hanzi",
    "korean": "Korean hangul",
}

def _resolve_unit(unit_cfg: str | None, output_lang: str | None) -> str:
    """Return "chars" or "words" based on explicit config or auto-detect from language."""
    if unit_cfg in ("chars", "words"):
        return unit_cfg
    # auto
    if not output_lang:
        return "words"
    lo = output_lang.lower()
    for hint in _CJK_LANG_HINTS:
        if hint in lo:
            return "chars"
    return "words"


def _measure(text: str, unit: str) -> int:
    if unit == "chars":
        return len(text)
    return len(text.split())


def _unit_label(unit: str) -> str:
    return "characters" if unit == "chars" else "words"


# --- REQ + helpers ---------------------------------------------------------

def _build_req(cfg: dict) -> str:
    topic = cfg.get("topic", "")
    template = cfg.get("req_template") or _DEFAULT_REQ_TEMPLATE
    req = template.replace("[Điền Chủ Đề Của Bạn Vào Đây]", topic)
    req = req.replace("[Số lượng]", "1")

    vs_path = cfg.get("viral_sample_file")
    if vs_path:
        p = Path(vs_path)
        if p.exists():
            viral_text = p.read_text(encoding="utf-8", errors="ignore").strip()
            if viral_text:
                req += (
                    "\n\nDƯỚI ĐÂY LÀ KỊCH BẢN MẪU (CHỈ ĐỂ HỌC PHONG CÁCH — "
                    "TUYỆT ĐỐI KHÔNG SAO CHÉP nội dung, tên nhân vật, bối cảnh, "
                    "tình tiết của bài mẫu):\n"
                    f"{viral_text}"
                )
        else:
            print(f"[generate] WARNING: viral_sample_file not found: {p}")

    return req


def _band(target: int, tol: float) -> tuple[int, int]:
    return max(1, int(target * (1 - tol))), int(target * (1 + tol))


def _plan_parts(total: int, per_part: int) -> list[int]:
    if total <= per_part:
        return [total]
    n = math.ceil(total / per_part)
    base = total // n
    parts = [base] * n
    parts[-1] += total - base * n
    return parts


def _build_system_blocks(persona_md: str, req: str, cfg: dict) -> list[dict]:
    """Static blocks shared across all parts of one script. Cache-tagged."""
    lines = [
        "YOU ARE THIS WRITER. Follow the Persona DNA below as your absolute source of truth on style, tone, audience, focus, hook, pacing, emotional arc, closing, POV, and Do/Don't rules.",
        "",
        "=== PERSONA DNA ===",
        persona_md,
        "=== END PERSONA DNA ===",
        "",
        f"REQ: {req}",
    ]
    extra = (cfg.get("extra_instructions") or "").strip()
    if extra:
        lines += ["", f"EXTRA INSTRUCTIONS (override / augment for this batch):\n{extra}"]
    output_lang = cfg.get("output_language")
    if output_lang:
        lines += ["", f"OUTPUT LANGUAGE: {output_lang}."]

    # Anti-AI-detection rules — make it read like a human wrote.
    if cfg.get("human_voice", True):
        extra = (cfg.get("human_voice_extra") or "").strip()
        lines += ["", get_human_voice_rules(output_lang, extra=extra)]

    if cfg.get("tts_clean", True):
        lines += ["", "TTS CLEAN RULES (apply to EVERY part):", TTS_CLEAN_RULE]

    # Output line-break / paragraph formatting (TTS-ready).
    fmt_block = get_output_format(output_lang, cfg.get("output_format"))
    if fmt_block:
        lines += ["", fmt_block]

    return [text_block("\n".join(lines), cache=True)]


def _build_part_instruction(
    *,
    cfg: dict,
    unit: str,
    part_index: int,
    total_parts: int,
    part_target: int,
    part_min: int,
    part_max: int,
    total_target: int,
    total_min: int,
    total_max: int,
    written_so_far: int,
    remaining_target: int,
) -> str:
    """Per-part user message. Length contract phrased in the chosen unit."""
    output_lang = cfg.get("output_language") or "the output language"
    u = _unit_label(unit)   # "characters" or "words"

    lines = ["=== LENGTH CONTRACT ==="]

    if unit == "chars":
        _character = _LANGUAGE_CJK.get(output_lang.lower(), "characters")
        lines.append(
            f"All length figures below count CHARACTERS in {output_lang}. "
            f"Each {_character} block counts as 1 character. "
            "Do NOT mentally convert to English-equivalent length — count characters in the actual output language."
        )
    else:
        lines.append(
            f"All length figures below count WORDS in {output_lang} (whitespace-separated tokens). "
            "Aim for natural rhythm in the target language."
        )

    lines.append(f"Full script target: ~{total_target} {u}. Acceptable window: {total_min}–{total_max} {u}.")

    if total_parts > 1:
        lines.append(
            f"You have already written {written_so_far} {u} in previous parts of THIS script. "
            f"Remaining budget for parts not yet written: ~{remaining_target} {u}."
        )
        lines.append(
            f"THIS part (Part {part_index}/{total_parts}) target: ~{part_target} {u}. "
            f"Window for this part: {part_min}–{part_max} {u}."
        )
    else:
        lines.append(f"Write the entire script in this single response. Target ~{part_target} {u}; window {part_min}–{part_max} {u}.")

    lines += [
        "Soft target, not a hard count: aim for natural rhythm, but DO NOT fall below the minimum and DO NOT exceed the maximum.",
        "Do not pad with filler or repetition to hit length. Cut tangents rather than overshoot.",
        "=== END LENGTH CONTRACT ===",
        "",
    ]

    if total_parts == 1:
        lines.append("Write the COMPLETE script now: hook, development, climax/twist, closing — execute every section of the Persona DNA.")
    else:
        if part_index == 1:
            lines.append("ROLE: OPENING. Execute the Hook Pattern from the Persona DNA. Establish character + setting + emotional question. DO NOT resolve. DO NOT foreshadow the ending. End on a beat that pulls into the next part.")
        elif part_index == total_parts:
            lines.append("ROLE: FINAL part. Continue seamlessly from what you have already written above. Deliver climax/twist and execute the Closing Pattern. You may stretch or compress within the window to land the total length cleanly. End the story.")
        else:
            lines.append("ROLE: MIDDLE part. Continue seamlessly from what you have already written above. Apply Pacing & Retention tactics. Escalate tension. Insert at least one mini-twist or revelation. DO NOT introduce an ending. End on a beat that pulls into the next part.")

    lines.append("")
    lines.append(f"Now write Part {part_index} of {total_parts}. Output only the narration text — no preamble, no headers, no commentary.")
    return "\n".join(lines)


def _rebalance(remaining_parts: list[int], surplus: int, min_floor: int) -> list[int]:
    if not remaining_parts:
        return remaining_parts
    delta = surplus // len(remaining_parts)
    return [max(min_floor, p - delta) for p in remaining_parts]


def generate(cfg: dict, client: BaseClient) -> list[Path]:
    persona_path = Path(cfg["persona_file"])
    if not persona_path.exists():
        raise RuntimeError(f"Persona file not found: {persona_path}. Run `train` first.")
    persona_md = persona_path.read_text(encoding="utf-8")

    output_dir = Path(cfg["output_folder"])
    output_dir.mkdir(parents=True, exist_ok=True)

    log_enabled = bool(cfg.get("log_requests", True))
    log_dir = Path(cfg.get("log_dir", "log"))
    if log_enabled:
        log_dir.mkdir(parents=True, exist_ok=True)

    req = _build_req(cfg)
    quantity = int(cfg["quantity"])
    total_target = int(cfg["target_length"])
    length_per_part = int(cfg["length_per_part"])
    tol = float(cfg.get("length_tolerance", 0.15))
    total_min, total_max = _band(total_target, tol)

    # Resolve unit (words for Latin, chars for CJK by default).
    unit = _resolve_unit(cfg.get("length_unit"), cfg.get("output_language"))
    u_label = _unit_label(unit)
    # Floor for rebalance: don't let any part shrink below ~25% of original target.
    min_floor = max(50, length_per_part // 4)

    base_plan = _plan_parts(total_target, length_per_part)
    total_parts = len(base_plan)

    system_blocks = _build_system_blocks(persona_md, req, cfg)

    written: list[Path] = []
    for n in range(1, quantity + 1):
        print(
            f"\n[generate] Script {n}/{quantity} — {total_parts} part(s), "
            f"target {total_target} {u_label} (window {total_min}-{total_max}) [unit={unit}]"
        )
        parts_text: list[str] = []
        plan = list(base_plan)
        written_so_far = 0
        messages: list[dict] = []

        log_buffer: list[str] = []
        if log_enabled:
            log_buffer.append(format_log_header(
                script_idx=n,
                total_scripts=quantity,
                provider=getattr(client, "provider", "?"),
                model=cfg["model_generation"],
                output_language=cfg.get("output_language"),
                unit=unit,
                target_total=total_target,
                window_min=total_min,
                window_max=total_max,
                total_parts=total_parts,
                topic=cfg.get("topic", ""),
            ))

        for i in range(total_parts):
            part_target = plan[i]
            part_min, part_max = _band(part_target, tol)
            remaining_target = sum(plan[i:])

            instruction = _build_part_instruction(
                cfg=cfg,
                unit=unit,
                part_index=i + 1,
                total_parts=total_parts,
                part_target=part_target,
                part_min=part_min,
                part_max=part_max,
                total_target=total_target,
                total_min=total_min,
                total_max=total_max,
                written_so_far=written_so_far,
                remaining_target=remaining_target,
            )

            if i == 0:
                user_blocks = system_blocks + [text_block(instruction)]
            else:
                user_blocks = [text_block(instruction)]
            messages.append({"role": "user", "content": user_blocks})

            print(
                f"  - Part {i+1}/{total_parts} target ~{part_target} {u_label} "
                f"(window {part_min}-{part_max}) | written so far: {written_so_far}"
            )
            # Snapshot messages BEFORE the call so the log shows exactly what was sent.
            sent_messages = [dict(m) for m in messages]

            text = client.complete_messages(
                messages=messages,
                model=cfg["model_generation"],
                max_tokens=cfg.get("max_tokens", 8000),
            ).strip()

            actual = _measure(text, unit)
            surplus = actual - part_target
            print(f"    -> got {actual} {u_label} (delta {surplus:+d})")

            if log_enabled:
                log_buffer.append(format_request_entry(
                    request_idx=i + 1,
                    part_index=i + 1,
                    total_parts=total_parts,
                    messages=sent_messages,
                    response_text=text,
                    actual_length=actual,
                    unit_label=u_label,
                    target=part_target,
                    model=cfg["model_generation"],
                    provider=getattr(client, "provider", "?"),
                ))

            messages.append({"role": "assistant", "content": text})
            parts_text.append(text)
            written_so_far += actual

            if i + 1 < total_parts:
                plan[i + 1:] = _rebalance(plan[i + 1:], surplus, min_floor=min_floor)

        full_script = "\n\n".join(parts_text)
        total_len = _measure(full_script, unit)
        in_band = total_min <= total_len <= total_max
        flag = "OK" if in_band else "OUT-OF-BAND"
        ts = datetime.now().strftime("%Y_%m_%d_%H_%M_%S")
        out_path = output_dir / f"Script_{n}_{ts}.txt"
        out_path.write_text(full_script, encoding="utf-8")
        written.append(out_path)
        print(f"  => Saved {out_path.name} | {total_len} {u_label} [{flag}, window {total_min}-{total_max}]")

        if log_enabled:
            log_buffer.append(format_log_footer(
                total_actual=total_len,
                unit_label=u_label,
                window_min=total_min,
                window_max=total_max,
            ))
            log_path = log_dir / f"Script_{n}_{ts}.txt"
            log_path.write_text("\n".join(log_buffer), encoding="utf-8")
            print(f"  => Logged {log_path}")

    return written
