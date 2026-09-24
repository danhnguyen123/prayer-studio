"""Anti-AI-detection rules — make scripts read like a human wrote them.

YouTube quét "inauthentic content" — output máy móc, có markers AI rõ rệt sẽ bị
phạt reach. Module này gắn 1 block rules vào prompt mỗi request để model né
những pattern lộ dấu vết AI.

Cấu trúc:
- UNIVERSAL_RULES: áp dụng mọi ngôn ngữ
- LANGUAGE_RULES: do/don't cụ thể cho từng ngôn ngữ (JP, VN, EN)
- get_human_voice_rules(lang) → ghép universal + language-specific

Nguyên tắc nội dung mỗi rule:
- ❌ avoid (ví dụ cụ thể của cái không nên viết)
- ✅ replace with (ví dụ cụ thể của cái nên viết)
Model bắt chước example tốt hơn đọc lý thuyết.
"""
from __future__ import annotations


UNIVERSAL_RULES = """\
=== HUMAN VOICE RULES (anti AI-detection) ===
YouTube đang phạt nội dung có dấu hiệu AI (inauthentic content). Viết như con người THẬT —
KHÔNG máy móc, KHÔNG có dấu vết AI. Tuân thủ NGHIÊM NGẶT các nguyên tắc sau:

1. KHÔNG dùng cấu trúc liệt kê máy móc:
   ❌ "Thứ nhất... Thứ hai... Thứ ba..." / "第一に〜、第二に〜、第三に〜" / "First... Second... Third..."
   ✅ Dùng kết nối tự nhiên: "Trước hết..." rồi "Và..." rồi "Cuối cùng..." / "まず、〜。そして、〜。最後に、〜"

2. KHÔNG lặp lại pattern câu kết. Đa dạng hoá đuôi câu:
   - Câu trước kết thúc bằng X → câu sau phải đổi sang Y/Z/W.
   - Tiếng Nhật: 「〜のです」「〜なのです」「〜ですね」「〜でしょう」「〜だ」「〜よね」 xoay vòng.
   - Tiếng Việt: "...rồi", "...đấy", "...nhỉ", "...mà", "...thế" / kết câu cụt.
   - Tiếng Anh: vary "...is.", "...isn't it?", "...you know.", fragments.

3. KHÔNG dùng từ nối kiểu AI (lạm dụng connectives):
   ❌ "Hơn nữa", "Thêm vào đó", "Bên cạnh đó", "Furthermore", "Moreover", "Additionally"
   ❌ さらに / また / 加えて / なお / ちなみに (dùng lặp)
   ✅ "Mà này...", "Còn nữa...", "Chưa hết...", "そして...", "でも...", "そう、〜", "ね、〜"

4. KHÔNG dùng câu hoàn hảo ngữ pháp 100%. Pha câu cụt + câu kéo dài:
   ❌ Câu nào cũng có chủ ngữ - vị ngữ - bổ ngữ đầy đủ, đối xứng.
   ✅ Có lúc giấu chủ ngữ (省略主語), có câu chỉ 1-2 từ, có câu chạy dài liền mạch như nghĩ ra.
   ✅ Bắt đầu câu bằng "Và", "Nhưng", "Vì" — như giọng nói thật.

5. KHÔNG dùng số liệu / mức độ tuyệt đối quá tròn:
   ❌ "100%", "50%", "10 lần", "Chính xác", "Tuyệt đối", "Cực kỳ"
   ✅ "gần như hoàn toàn", "khoảng một nửa", "gần 10 lần", "ほぼ完全に", "半分くらい", "10倍近く"

6. KHÔNG dùng cụm "lộ dấu vết dịch máy / AI":
   ❌ "Điều đó nói rằng...", "Nói cách khác...", "Hãy để tôi nói cho bạn biết..."
   ❌ "Nghiên cứu chỉ ra rằng...", "Các nhà khoa học đã chứng minh rằng...", "Theo các chuyên gia..."
   ❌ "Đó là lý do tại sao...", "Đây là lý do..."
   ❌ "Bạn có biết không?" (quá Tây — nếu cần, dùng "Quý vị có biết...")
   ❌ Mở câu bằng "Vâng,..." (kiểu "Yes,...")
   ❌ "Trong bài viết này...", "Trong video hôm nay chúng ta sẽ học..."
   ❌ "Thật tuyệt vời!", "Thật đáng kinh ngạc!"
   ✅ Nói cụ thể, có chi tiết, có cảm xúc cá nhân. Tránh meta-narration.

7. KHÔNG dùng câu bị động kiểu dịch:
   ❌ "được phát hiện bởi...", "được thực hiện bởi..."
   ✅ Đảo chủ động: "X đã phát hiện ra..."

8. THÊM dấu vết con người:
   ✅ Lặp từ có ý đồ ("rất, rất chậm"), tự sửa giữa câu ("không, đúng hơn là..."),
      câu hỏi tu từ tự đặt rồi tự trả lời, cảm thán ngắn (À, Ờ, Ừm, ああ, なるほど).
   ✅ Chi tiết cảm giác cụ thể (mùi, âm thanh, ánh sáng, nhiệt độ) thay vì khái niệm trừu tượng.
   ✅ Số liệu lẻ ("47 năm", "khoảng 12 phút" thay vì "50 năm", "10 phút").

NGUYÊN TẮC LỚN: 70% tuân thủ rules trên, 30% phá vỡ một cách tự nhiên — vì người thật KHÔNG nhất quán."""


# ----- Language-specific overrides / additions ------------------------------

JAPANESE_RULES = """\
--- JAPANESE specifics ---
- 文末đa dạng: 「のです」「なのです」「ですね」「でしょう」「だ」「よね」「だろう」 xoay vòng, KHÔNG lặp 3 câu liền.
- 接続詞 tránh lặp: さらに / また / 加えて / なお / ちなみに → ưu tiên そして / でも / だから / それで.
- Tránh liệt kê 第一に〜、第二に〜 → dùng まず / そして / 最後に.
- 省略主語 tự nhiên (giấu chủ ngữ khi context rõ).
- Số: ほぼ / くらい / 近く / 程度 thay cho con số tròn.
- Cảm thán ngắn tự nhiên: ああ / そう / ええ / なるほど / うん.
- 60+ audience: tránh slang giới trẻ (やばい / 草 / マジで), tránh từ ngoại lai khó (アイデンティティ → 自分らしさ).
"""


VIETNAMESE_RULES = """\
--- VIETNAMESE specifics ---
- Cấm cụm AI/dịch máy: "Điều đó nói rằng", "Nói cách khác", "Hãy để tôi nói cho bạn biết",
  "Nghiên cứu chỉ ra rằng", "Theo các chuyên gia", "Đó là lý do tại sao", "Bạn có biết không?",
  "Trong bài viết này", "Trong video hôm nay", "Thật tuyệt vời", "Thật đáng kinh ngạc",
  "Chính xác", "Tuyệt đối", "Cực kỳ", "Hơn nữa", "Thêm vào đó", "Bên cạnh đó".
- Thay bằng: "Mà này...", "Còn nữa...", "Chưa hết...", "Thật ra thì...", "Nói thật là...",
  "Tự dưng...", "Có lẽ vì...", "À mà...".
- KHÔNG mở câu bằng "Vâng,..." (Tây hoá).
- Dùng từ địa phương / khẩu ngữ vừa phải: "ấy", "đấy", "nhỉ", "à", "ờ" — tự nhiên như nói chuyện.
- Câu bị động "được X bởi Y" → đảo chủ động "Y đã X".
- 25-45 nữ: avoid mỹ từ sến súa, ưu tiên ngôn ngữ trực diện + đanh thép.
"""


ENGLISH_RULES = """\
--- ENGLISH specifics ---
- Avoid AI tells: "Moreover", "Furthermore", "Additionally", "In conclusion", "In summary",
  "It's important to note", "It's worth mentioning", "Studies show", "Experts agree",
  "This article will explore", "Today we'll learn", "Let me tell you", "That said".
- Replace with: "Also...", "Plus...", "And here's the thing —", "Now,...", "But wait —", "So,...".
- Avoid opening with "Yes,..." (translation tell).
- Use contractions (don't, won't, it's, you're) liberally.
- Mix fragment sentences. Like this one. Or this. Yeah.
- Active voice over passive: "Scientists discovered X" not "X was discovered by scientists".
- Specific numbers: "47 minutes" not "about an hour"; "$1,283" not "around $1,000".
"""


POLISH_RULES = """\
--- POLISH specifics ---
- Cấm cụm AI / dịch máy:
  ❌ "Ponadto", "Dodatkowo", "Co więcej", "Co istotne", "Warto zauważyć", "Warto wspomnieć"
  ❌ "To powiedziawszy", "Innymi słowy", "Pozwól, że ci powiem"
  ❌ "Według ekspertów", "Badania pokazują/wykazują" (mơ hồ — nếu cần thì cite cụ thể: "W badaniu UW z 2024…")
  ❌ "W tym artykule omówimy…", "W tym filmie dowiecie się…", "Dzisiaj nauczymy się…"
  ❌ Mở câu bằng "Otóż…" (quá formal AI), "Tak więc…" lặp.

- Thay bằng kết nối tự nhiên / khẩu ngữ:
  ✅ "A jeszcze…", "No i…", "Wiesz co?", "Tak swoją drogą…", "Jeszcze jedno…", "A właśnie…"
  ✅ "Najpierw… potem… wreszcie…" (KHÔNG dùng "Po pierwsze / Po drugie / Po trzecie" máy móc).

- Pro-drop tự nhiên (tiếng Ba Lan KHÔNG bắt buộc chủ ngữ):
  ❌ "Ja myślę, że ja powinienem zrobić to."
  ✅ "Myślę, że powinienem to zrobić."
  → Giấu "ja / ty / my" khi context rõ — như người Ba Lan nói chuyện thật.

- Particles / filler tự nhiên (rất quan trọng để né AI detection):
  ✅ "no", "więc", "no to", "po prostu", "tak naprawdę", "no właśnie", "wiesz", "hmm", "eee",
     "no dobra", "no cóż", "chyba".
  → Rải 2-3 cái mỗi đoạn dài, KHÔNG dùng cả cụm formal toàn bài.

- Câu bị động kiểu dịch:
  ❌ "Zostało to odkryte przez naukowców z Krakowa."
  ✅ "Naukowcy z Krakowa to odkryli."

- Tránh intensifier tuyệt đối lạm dụng:
  ❌ "Zdecydowanie", "Absolutnie", "Niewątpliwie", "Bezsprzecznie", "Całkowicie", "W stu procentach"
  ✅ "Raczej", "Można powiedzieć, że…", "W zasadzie", "Chyba", "Wydaje mi się, że…"

- Số liệu / tỷ lệ KHÔNG quá tròn:
  ❌ "100%", "50%", "10 razy", "miliard ludzi"
  ✅ "prawie wszyscy", "około połowy", "prawie dziesięć razy", "ponad osiemset milionów"

- Đa dạng câu kết — không lặp 3 câu liền cùng kết:
  Xoay vòng "…jest", "…można", "…trzeba", "…warto", fragment cụt, câu hỏi tu từ.

- Diminutive khi tự nhiên (Ba Lan rất hay dùng):
  ✅ "chwilkę", "kawusię", "minutkę", "kotek" — nhưng KHÔNG nhồi nhét, chỉ chỗ phù hợp cảm xúc.

- Fragments + tự sửa giữa câu (dấu vết người thật):
  ✅ "Tak. Po prostu tak."  /  "Nie, raczej… nie wiem, jak to powiedzieć."  /  "Hmm, ciekawe."

- Diacritics ĐẦY ĐỦ: ą ć ę ł ń ó ś ź ż — KHÔNG được lười bỏ dấu.
"""


LANGUAGE_RULES = {
    "japanese": JAPANESE_RULES,
    "vietnamese": VIETNAMESE_RULES,
    "english": ENGLISH_RULES,
    "polish": POLISH_RULES,
}


# Substring → canonical key (so "Japanese (Nhật Bản)" → "japanese")
_LANG_HINTS = {
    "japanese": ("japanese", "nhật", "日本"),
    "vietnamese": ("vietnamese", "việt", "tiếng việt"),
    "english": ("english", "anh"),
    "polish": ("polish", "polski", "polska", "ba lan"),
    # Future: chinese, korean, spanish — fall back to universal-only for now.
}


def _resolve_lang_key(output_language: str | None) -> str | None:
    if not output_language:
        return None
    lo = output_language.lower()
    for key, hints in _LANG_HINTS.items():
        for h in hints:
            if h in lo:
                return key
    return None


def get_human_voice_rules(output_language: str | None, extra: str = "") -> str:
    """Return the full anti-AI block to inject into the prompt header.

    Combines universal rules + language-specific block + optional `extra` (per-batch
    custom additions from YAML).
    """
    lang_key = _resolve_lang_key(output_language)
    lang_block = LANGUAGE_RULES.get(lang_key, "") if lang_key else ""

    parts = [UNIVERSAL_RULES.strip()]
    if lang_block:
        parts.append(lang_block.strip())
    if extra and extra.strip():
        parts.append("--- EXTRA RULES (per-batch) ---\n" + extra.strip())
    parts.append("=== END HUMAN VOICE RULES ===")
    return "\n\n".join(parts)
