"""Output formatting rules — TTS-ready line breaks.

Tells the model how to lay out lines/paragraphs so the output drops cleanly into
a TTS engine with natural pause timing.

Same architecture as human_voice.py:
- UNIVERSAL block — applies regardless of language
- LANGUAGE_FORMATS dict — per-language do/don't
- get_output_format(language, override) → resolver

Config:
  output_format: "auto"   # default: language default
  output_format: "off"    # disable entirely
  output_format: "<custom string>"  # explicit override, replaces default
"""
from __future__ import annotations


UNIVERSAL_FORMAT = """\
=== OUTPUT FORMATTING (TTS-ready) ===
- Single column of plain narration text. No tables, no columns, no indentation.
- Use ONE blank line between paragraphs (scene shift, topic shift, time skip).
- No leading/trailing whitespace on lines."""


JAPANESE_FORMAT = """\
--- Japanese line breaks ---
- Mỗi câu kết thúc bằng 「。」「？」「！」 → XUỐNG DÒNG ngay sau dấu chấm.
- Câu chứa lời thoại trong dấu 「...」 → GIỮ TRÊN 1 DÒNG (không ngắt giữa câu thoại,
  kể cả khi câu dài). Ví dụ: 田中さんは静かに呟いた、「もう、こんな時間か」。
- Câu mô tả / nội tâm / chuyển cảnh → mỗi câu 1 dòng, để TTS pause rõ ràng.
- KHÔNG nối nhiều câu trên cùng 1 dòng bằng dấu phẩy / 「、」.

Ví dụ output đúng:
朝の光が薄く差し込んでいた。
窓の外には小さな庭が見える。
田中さんは静かに呟いた、「もう、こんな時間か」。
コーヒーの香ばしい匂いが部屋にゆっくりと広がっていった。
"""


VIETNAMESE_FORMAT = """\
--- Vietnamese line breaks ---
- Mỗi câu kết thúc bằng "." "?" "!" → xuống dòng ngay sau.
- Câu chứa lời thoại trong dấu ngoặc kép "..." → giữ trên 1 dòng cùng với mệnh đề bao quanh.
- Đoạn mô tả dài → chia thành nhiều câu ngắn, mỗi câu 1 dòng.
- KHÔNG nối 2 câu bằng "; " hoặc " — " trên cùng dòng.
"""


ENGLISH_FORMAT = """\
--- English line breaks ---
- One sentence per line. End with period / question mark / exclamation.
- Dialogue in quotes stays on a single line with its surrounding clause.
- Blank line between paragraphs (scene/topic shift).
- Do NOT use em-dash to join two sentences on one line — split them.
"""


LANGUAGE_FORMATS = {
    "japanese": JAPANESE_FORMAT,
    "vietnamese": VIETNAMESE_FORMAT,
    "english": ENGLISH_FORMAT,
}


_LANG_HINTS = {
    "japanese": ("japanese", "nhật", "日本"),
    "vietnamese": ("vietnamese", "việt"),
    "english": ("english", "anh"),
}


def _resolve_lang_key(output_language: str | None) -> str | None:
    if not output_language:
        return None
    lo = output_language.lower()
    for key, hints in _LANG_HINTS.items():
        if any(h in lo for h in hints):
            return key
    return None


def get_output_format(output_language: str | None, override: str | None) -> str:
    """Return the formatting block to inject into the prompt header.

    override behaviour:
      - None / "" / "auto"         → use universal + language default
      - "off" / "none" / "false"   → empty string (skip entirely)
      - any other string           → use as the format block content (replaces default)
    """
    if override:
        low = override.strip().lower()
        if low in ("off", "none", "false", "no", "disable"):
            return ""
        if low not in ("auto", ""):
            # Treat as user-provided custom format block.
            return (
                "=== OUTPUT FORMATTING (TTS-ready) ===\n"
                f"{override.strip()}\n"
                "=== END OUTPUT FORMATTING ==="
            )

    # auto
    parts = [UNIVERSAL_FORMAT.strip()]
    lang_key = _resolve_lang_key(output_language)
    lang_block = LANGUAGE_FORMATS.get(lang_key) if lang_key else None
    if lang_block:
        parts.append(lang_block.strip())
    parts.append("=== END OUTPUT FORMATTING ===")
    return "\n\n".join(parts)
