# Writer Pro — Python + Claude API

Tool tự động viết kịch bản YouTube dài (story, drama, emotional storytelling, sảng văn, review, lịch sử, Phật pháp…) bằng Claude API. Học phong cách từ kịch bản mẫu của bạn, đóng gói thành **Persona DNA** dùng lại nhiều lần, sinh hàng loạt kịch bản theo topic — output sạch sẵn cho text-to-speech.

Đây là bản viết lại bằng Python của tool exe `Writer_Pro_v1` (DeepSeek), thay backend bằng Claude và nâng cấp:
- **Persona DNA** là file `.md` đọc được, sửa tay được — không phải binary `.dat`.
- **Prompt caching** → tiết kiệm 60–80% chi phí khi sinh hàng loạt.
- **Length contract + closed-loop rebalance** → tổng độ dài bám sát target, không lệch nặng giữa các video.
- **Multi-config, multi-language, multi-channel** — mỗi thể loại 1 file YAML riêng.

---

## 1. Cài đặt

```bash
git clone <repo>
cd auto-script

python -m venv .venv
.venv\Scripts\activate              # Windows
# source .venv/bin/activate         # macOS/Linux

pip install -r requirements.txt
```

Yêu cầu: Python 3.10+.

### Cài API key

Mở `API.txt`, dán key Anthropic vào (mỗi dòng một key — tool sẽ rotate khi gặp rate limit):

```
sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
sk-ant-api03-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
```

Lấy key tại: https://console.anthropic.com/settings/keys

---

## 2. Cấu trúc project

```
auto-script/
├── API.txt                       # Anthropic API key(s)
├── requirements.txt
├── run.py                        # CLI entry
├── configs/                      # Mỗi thể loại / channel 1 file YAML
│   ├── japan_senior.yaml
│   └── vietnamese_story.yaml
├── src/
│   ├── ai_client.py              # AnthropicClient + DeepSeekClient + factory
│   ├── config.py
│   ├── train.py                  # Phase 1: Persona DNA
│   └── generate.py               # Phase 2: viết kịch bản
├── samples/                      # Kịch bản mẫu để học style
│   ├── japan_senior/             #  → file *.txt
│   └── vn_sangvan/
├── personas/                     # Auto-tạo: analysis_*.md (Persona DNA)
└── output/                       # Auto-tạo: Script_N_<timestamp>.txt
```

---

## 3. Luồng sử dụng

Có 2 phase:

| Phase | Lệnh | Khi nào chạy |
|---|---|---|
| **1. Training** | `python run.py train --config X.yaml` | Chạy 1 lần cho mỗi channel. Build/refine Persona DNA. |
| **2. Generation** | `python run.py generate --config X.yaml` | Chạy mỗi khi cần sinh kịch bản (đổi topic là chạy lại). |
| Cả 2 | `python run.py all --config X.yaml` | Tự skip Phase 1 nếu persona đã tồn tại. |

### Bước 1: Chuẩn bị samples

Bỏ 5–10 file `.txt` kịch bản mẫu hay nhất của channel vào folder `samples/<your_channel>/`. Càng đại diện cho phong cách bạn muốn, Persona DNA càng chính xác.

### Bước 2: Tạo file config YAML

Copy `configs/japan_senior.yaml` → đổi tên, chỉnh theo nhu cầu. Xem chi tiết các field ở mục **4**.

### Bước 3: Build Persona DNA (Phase 1)

```bash
python run.py train --config configs/japan_senior.yaml
```

Output: `personas/analysis_japan_senior.md` — đây là "linh hồn nhà văn" cho channel này.

**Mở file md này ra đọc.** Nó là document người-đọc-được, gồm 16 sections:

```
# Persona / Target Audience / Market & Output Language
# Focus / Style / Tone / Writing Style
# Vocabulary / Sentence Structure
# POV / Narrator Voice
# Hook Pattern / Pacing & Retention Tactics / Emotional Arc / Closing Pattern
# Narrative Structure
# Do / Don't
```

Có thể sửa tay từng section nếu muốn tinh chỉnh, hoặc chạy `train` lại với samples mới — tool sẽ **refine** persona cũ (incremental) thay vì viết đè.

### Bước 4: Sinh kịch bản (Phase 2)

Mở YAML, đổi field `topic`, rồi:

```bash
python run.py generate --config configs/japan_senior.yaml
```

Output: `output/japan_senior/Script_1_<ts>.txt`, `Script_2_<ts>.txt`, …

Mỗi file là 1 kịch bản hoàn chỉnh, output sạch cho text-to-speech (không markdown, không speaker label, không stage direction).

---

## 4. Tham chiếu YAML config

```yaml
name: "Japan 60+ Emotional Storytelling"      # nhãn hiển thị

# ===== Phase 1: Training =====
sample_folder:  "samples/japan_senior"        # folder chứa *.txt mẫu
persona_file:   "personas/analysis_japan_senior.md"   # output Phase 1 / input Phase 2

# Channel brief — feed vào Phase 1 cùng samples để build Persona DNA.
# Bạn mô tả ở đây: STYLE / TONE / FOCUS / WRITING STYLE / TARGET AUDIENCE,
# market, văn hoá, taboo. Samples chỉ thể hiện văn phong — brief bù phần
# audience/intent mà samples không bộc lộ rõ.
training_brief: |
  Channel YouTube cho người Nhật trên 60 tuổi (pension life, retirees).
  STYLE: Japanese realistic emotional storytelling.
  TONE: Gentle, reflective, emotional, comforting, slow-paced.
  FOCUS: Daily life, pension life, loneliness, small habits, healing.
  WRITING STYLE: Simple Japanese, natural dialogue, vivid everyday details.
  TARGET AUDIENCE: Japanese people over 60.
  Tránh: slang giới trẻ, đề tài chính trị/tôn giáo nhạy cảm.

# Hoặc dùng file riêng (override training_brief nếu set):
# training_brief_file: "personas/brief_japan_senior.md"

# ===== Phase 2: Generation =====
output_folder:    "output/japan_senior"

target_chars:     6000         # tổng độ dài kịch bản (soft target)
length_tolerance: 0.15         # ±15% → window 5100–6900 chars
chars_per_part:   3500         # mỗi request ~3500 chars; tự rebalance
quantity:         3            # số kịch bản sinh trong batch

max_tokens:       8000         # giới hạn output mỗi request Claude

# ===== Topic của batch =====
topic: "Một bà cụ goá chồng tìm lại niềm vui qua quán café nhỏ"

# Optional: ngôn ngữ output. Null → Persona DNA tự quyết.
output_language:  "Japanese"

# Optional: override / augment cho batch hiện tại, không sửa persona.
# extra_instructions: |
#   Lần này chèn 1 ký ức tuổi 20 của nhân vật chính.
#   Kết bài bằng 1 câu hỏi mở để khán giả comment.

# ===== TTS clean =====
tts_clean: true     # remove markdown, list, speaker label, stage direction…

# ===== Model =====
model_training:    "claude-opus-4-7"    # Opus → chất lượng cao, dùng 1 lần
model_generation:  "claude-opus-4-7"    # Có thể đổi "claude-sonnet-4-6" để rẻ hơn 5x

# Optional: override REQ template. Placeholder: [Điền Chủ Đề Của Bạn Vào Đây]
# req_template: |
#   ...
```

### Field bắt buộc tối thiểu

```yaml
sample_folder:  "samples/xxx"
persona_file:   "personas/analysis_xxx.md"
output_folder:  "output/xxx"
topic:          "..."
training_brief: "..."   # cho Phase 1
```

Tất cả còn lại có default.

---

## 5. Length Contract — cách độ dài được kiểm soát

Vấn đề tool gốc: viết 6000 chars có thể ra 3500 hoặc 9000 — video YouTube lệch giờ.

Tool này giải quyết bằng 3 lớp:

1. **Tolerance band**: `target_chars: 6000` + `length_tolerance: 0.15` → acceptable window `[5100, 6900]`.
2. **Per-part contract**: Mỗi request Claude được nói rõ tổng target, đã viết bao nhiêu, còn lại bao nhiêu, part này target bao nhiêu — đồng thời 3 layer ràng buộc.
3. **Closed-loop rebalance**: Sau mỗi part, code đo `len(text)` thực, tự động điều chỉnh target các part còn lại để bù sai số.

Log sẽ in:

```
[generate] Script 1/3 — 2 part(s), target 6000 (window 5100-6900)
  - Part 1/2 target ~3000 (window 2550-3450) | written so far: 0
    -> got 3120 chars (delta +120)
  - Part 2/2 target ~2880 (window 2448-3312) | written so far: 3120
    -> got 2904 chars (delta +24)
  => Saved Script_1_<ts>.txt | 6024 chars [OK, window 5100-6900]
```

Nếu out-of-band:

```
=> Saved Script_2_<ts>.txt | 7200 chars [OUT-OF-BAND, window 5100-6900]
```

→ biết để chạy lại hoặc chỉnh tay.

### Tinh chỉnh

| Triệu chứng | Cách sửa |
|---|---|
| Hay viết hụt (~50-60% target) với tiếng Nhật/Trung/Hàn | Giảm `target_chars` còn ~50% giá trị English-equivalent (CJK dày 2-3x Latin) |
| Hay viết hụt với tiếng Anh/Việt | Giảm `length_tolerance` xuống `0.10`, tăng `max_tokens` lên `10000` |
| 1 part chạm trần (text bị cắt) | Tăng `max_tokens` hoặc giảm `chars_per_part` (chia nhiều part nhỏ hơn) |
| Quá nhiều OUT-OF-BAND | Nới `length_tolerance` lên `0.20` |
| Muốn 1 request 1 kịch bản (không chia part) | Set `chars_per_part >= target_chars` |

### Length unit — words vs chars

Models reason **words** tốt hơn cho ngôn ngữ Latin (English/Vietnamese/Spanish…), và **characters** tốt hơn cho CJK (Japanese/Chinese/Korean — 1 char ≈ 1 morpheme). Tool tự chọn unit theo `output_language`, hoặc bạn override.

```yaml
length_unit:      "auto"      # "auto" | "chars" | "words"
target_length:    4000        # diễn giải theo unit
length_per_part:  2000        # diễn giải theo unit
length_tolerance: 0.15
```

Auto-detect: nếu `output_language` chứa Japanese/Nhật/Chinese/Trung/Korean/Hàn → `chars`. Còn lại → `words`.

### Quy đổi tham khảo (cho cùng thời lượng TTS ~10 phút)

| Ngôn ngữ | Unit | `target_length` | `length_per_part` |
|---|---|---|---|
| English | words | 1500–1800 | 700–900 |
| Vietnamese | words | 2000–2500 | 1000–1200 |
| Spanish / French | words | 1500–1800 | 700–900 |
| **Japanese** | **chars** | **3500–4000** | **1800–2200** |
| **Chinese** | **chars** | **3000–3500** | **1500–1800** |
| **Korean** | **chars** | **3500–4000** | **1800–2200** |

→ CJK cần unit `chars` với target ~50-60% giá trị "feel-like-English". Latin dùng `words` để model bám natural rhythm hơn.

### Backward compat

Key cũ `target_chars` / `chars_per_part` vẫn hoạt động — auto map sang `target_length` / `length_per_part` khi load YAML. Khuyến nghị migrate sang key mới + thêm `length_unit`.

---

## 6. Tối ưu chi phí — Prompt Caching

Persona DNA + REQ + extra_instructions được đánh dấu `cache_control: ephemeral` (TTL 5 phút). Khi sinh nhiều part / nhiều kịch bản liên tiếp:

- Request 1: tính phí đầy đủ (write cache).
- Request 2–N: phần persona chỉ trả 10% giá (read cache).

Với batch 5 kịch bản × 2 part = 10 request, tiết kiệm ~60–80% so với không cache.

→ **Cứ chạy `quantity` lớn trong 1 lệnh** thay vì chạy nhiều lệnh nhỏ — cache mới hit.

---

## 7. Workflow đa channel

```
auto-script/
├── configs/
│   ├── japan_senior.yaml
│   ├── vn_sangvan.yaml
│   ├── us_motivation.yaml
│   └── china_xianxia.yaml
├── personas/
│   ├── analysis_japan_senior.md
│   ├── analysis_vn_sangvan.md
│   └── ...
└── samples/
    ├── japan_senior/
    ├── vn_sangvan/
    └── ...
```

Mỗi channel = 1 YAML + 1 folder samples + 1 persona md. Switch channel = chỉ đổi `--config`.

---

## 8. Refine persona theo thời gian

Khi channel có thêm video viral mới hoặc bạn muốn nâng cấp style:

1. Thêm `.txt` mẫu mới vào `samples/<channel>/` (có thể xoá bớt cái cũ).
2. (Optional) Chỉnh `training_brief` trong YAML.
3. Chạy lại:
   ```bash
   python run.py train --config configs/<channel>.yaml
   ```
4. Persona DNA cũ được **refine** (merge insight mới + giữ rule cũ vẫn đúng), không bị viết đè vô tội vạ.

Nếu muốn build lại từ đầu: xoá file `personas/analysis_<channel>.md` rồi `train`.

---

## 9. Các lệnh

```bash
# Phase 1 — Build/refine Persona DNA
python run.py train    --config configs/japan_senior.yaml

# Phase 2 — Sinh kịch bản
python run.py generate --config configs/japan_senior.yaml

# Cả 2 — Tự skip train nếu persona đã có
python run.py all      --config configs/japan_senior.yaml
```

---

## 10. So sánh với tool exe gốc

| Tool exe (`Writer_Pro_v1`) | Python version |
|---|---|
| Backend DeepSeek | Backend Claude (Opus 4.7 / Sonnet 4.6) |
| Knowledge Base `.dat` (binary) | Persona DNA `.md` (đọc & sửa tay được) |
| Persona chỉ có Tone/Vocab/Structure | 16 sections: + Hook, Pacing, Emotional Arc, Closing, POV, Audience, Focus, Do/Don't… |
| Style/Tone/Market nhập trong UI | Nằm trong Persona DNA, sinh từ training_brief + samples |
| 2000 chars / part cứng | Adaptive `chars_per_part` + closed-loop rebalance |
| Tổng độ dài dễ lệch | Tolerance band + length contract |
| Không cache | Prompt caching, tiết kiệm 60–80% cost |
| 1 API key | Multi-key rotation |
| GUI | CLI + YAML config (dễ automate / batch) |
| Check API balance | Skip (Claude tự fail-fast nếu key sai) |
| SEO Metadata | Chưa làm (kế hoạch sau) |

---

## 11. Troubleshooting

**`No API keys found in API.txt`**
→ Mở `API.txt`, paste key Anthropic vào (dòng không bắt đầu bằng `#`).

**`Persona file not found. Run 'train' first.`**
→ Phase 1 chưa chạy. Chạy `train` trước, hoặc dùng lệnh `all`.

**`No .txt samples found in samples/...`**
→ Folder samples rỗng. Bỏ ít nhất 1 file `.txt` vào.

**Output kịch bản bị cắt giữa câu**
→ Chạm `max_tokens`. Tăng `max_tokens` lên 10000, hoặc giảm `chars_per_part`.

**Rate limit liên tục**
→ Thêm key thứ 2 vào `API.txt` (mỗi dòng 1 key) — tool tự rotate.

**Persona DNA viết sơ sài**
→ Tăng số sample (5–10 cái), viết `training_brief` chi tiết hơn, dùng `model_training: claude-opus-4-7`.

---

## 12. Đổi provider (Anthropic ↔ DeepSeek)

Tool hỗ trợ 2 provider qua **2 client tách biệt**, mỗi cái gọi native API của provider đó:

| Provider | Client | Endpoint | Models | Cache control | API key file mặc định |
|---|---|---|---|---|---|
| `anthropic` (default) | `AnthropicClient` (anthropic SDK) | api.anthropic.com/v1/messages | `claude-opus-4-7`, `claude-sonnet-4-6`… | Explicit (`cache_control: ephemeral`) | `API.txt` |
| `deepseek` | `DeepSeekClient` (requests) | api.deepseek.com/chat/completions | `deepseek-v4-pro`, `deepseek-v4-flash` | Automatic server-side KV cache (no marker) | `API_DEEPSEEK.txt` |

**Cả 2 đều caching được** — chỉ khác cơ chế. Code chúng ta giữ persona DNA ở vị trí ổn định trong prefix → cache hit tự nhiên cho cả 2 provider.

### Cách switch

```yaml
# configs/your_channel.yaml
provider: "deepseek"                   # "anthropic" | "deepseek"
# api_file: "API_DEEPSEEK.txt"         # auto theo provider; chỉ set khi muốn override
model_training:   "deepseek-v4-pro"    # cho Persona DNA
model_generation: "deepseek-v4-pro"    # hoặc "deepseek-v4-flash" để rẻ hơn
```

Bỏ DeepSeek API key vào `API_DEEPSEEK.txt` (mỗi dòng 1 key, format `sk-...`).

```bash
python run.py train    --config configs/japan_senior_deepseek.yaml
python run.py generate --config configs/japan_senior_deepseek.yaml
```

### Lưu ý khi dùng DeepSeek

- Client gọi thẳng `/chat/completions` (OpenAI-style) qua `requests`, **không đi qua anthropic SDK** → tách biệt hoàn toàn, không bị compat layer giới hạn.
- `cache_control: ephemeral` markers tự động bị drop khi flatten content (DeepSeek không hiểu marker này) — không lỗi.
- DeepSeek có **automatic Context Caching (KV cache)** server-side: prefix giống nhau giữa các request → tự cache, không cần marker. Doc: <https://api-docs.deepseek.com/guides/kv_cache>
- Multi-round conversation: DeepSeek hỗ trợ native — code chúng ta dùng cùng pattern `user → assistant → user` cho cả 2 provider. Doc: <https://api-docs.deepseek.com/guides/multi_round_chat>
- Models hợp lệ (hiện tại): `deepseek-v4-pro` (default) và `deepseek-v4-flash` (rẻ/nhanh hơn). Lưu ý `deepseek-chat` và `deepseek-reasoner` sẽ deprecated 2026/07/24.
- Anthropic-style content blocks (list of `{"type":"text","text":"..."}`) được tự động flatten thành plain string deterministic → train.py / generate.py giữ nguyên code, không cần biết đang chạy provider nào.
- Persona DNA `.md` **dùng chung được giữa 2 provider** — train bằng Anthropic, generate bằng DeepSeek (hoặc ngược lại) đều OK.

### Khi nào dùng provider nào

| Use case | Provider |
|---|---|
| Chất lượng cao nhất, sẵn budget | Anthropic Opus 4.7 |
| Batch lớn (50+ script/ngày), cần rẻ | DeepSeek v4-pro hoặc Anthropic Sonnet 4.6 |
| Persona DNA training (1 lần, cần chính xác) | Anthropic Opus 4.7 |
| A/B test 2 provider trên cùng persona | Tạo 2 YAML, 2 output_folder, so output |

### Combo workflow: train Anthropic, generate DeepSeek

Train bằng Opus (chất lượng Persona DNA cao), generate hàng loạt bằng DeepSeek (rẻ):

```yaml
# configs/japan_senior_train.yaml — chỉ dùng cho train
provider: "anthropic"
model_training: "claude-opus-4-7"
persona_file: "personas/analysis_japan_senior.md"
# ... rest ...
```

```yaml
# configs/japan_senior_gen.yaml — chỉ dùng cho generate
provider: "deepseek"
model_generation: "deepseek-v4-pro"
persona_file: "personas/analysis_japan_senior.md"   # ← cùng file persona
# ... rest ...
```

```bash
python run.py train    --config configs/japan_senior_train.yaml
python run.py generate --config configs/japan_senior_gen.yaml
```

---

## 13. Request logging — review prompt thực tế đã gửi

Mỗi script sinh ra sẽ kèm 1 file log ghi lại **body request thực tế** đã gửi đến API. Cùng tên với script output, lưu trong thư mục `log/`:

```
output/japan_senior_finance/
└── Script_1_1779120000.txt          # kịch bản

log/
└── Script_1_1779120000.txt          # request log tương ứng
```

### Format log

```
################################################################################
# Script 1/1
# Provider     : anthropic
# Model        : claude-opus-4-7
# Output lang  : Japanese
# Length unit  : chars
# Total target : 4000 chars (window 3400-4600)
# Parts        : 2
# Topic        : Câu chuyện và thói quen giúp người lớn tuổi...
################################################################################

================================================================================
 REQUEST 1  |  Part 1/2  |  provider=anthropic  model=claude-opus-4-7
================================================================================
---- turn 1 [role=user] ----
[cache_control=ephemeral]
YOU ARE THIS WRITER...
=== PERSONA DNA ===
<toàn bộ persona md>
=== END PERSONA DNA ===
REQ: ...
=== LENGTH CONTRACT ===
Full script target: ~4000 characters...
Now write Part 1 of 2.

--------------------------------------------------------------------------------
 RESPONSE (truncated)  (2030 characters, target 2000, delta +30)
--------------------------------------------------------------------------------
<50 ký tự đầu>...<50 ký tự cuối>

================================================================================
 REQUEST 2  |  Part 2/2
================================================================================
---- turn 1 [role=user] ----
[cache_control=ephemeral]
<persona header — same as request 1, full text>

---- turn 2 [role=assistant (truncated)] ----
こんにちは、田中さん。今朝も六時に目が覚...と思いました。
                ↑ assistant content rút gọn: <50 đầu>...<50 cuối>

---- turn 3 [role=user] ----
=== LENGTH CONTRACT ===
You have already written 2030 characters...
Now write Part 2 of 2.

--------------------------------------------------------------------------------
 RESPONSE (truncated)  (1980 characters, target 1970, delta +10)
--------------------------------------------------------------------------------
<50 ký tự đầu>...<50 ký tự cuối>

################################################################################
# TOTAL: 4010 chars  [OK, window 3400-4600]
################################################################################
```

### Tại sao truncate

Mục đích của log là review **prompt build** (cái user gửi), không phải lưu lại kịch bản (đã có ở `output/`). Vì vậy:
- `role=user` → giữ full (đây là cái cần review).
- `role=assistant` → truncate `<50 đầu>...<50 cuối>` (chỉ cần nhận diện part nào nằm ở đâu).
- `RESPONSE` từng part → cũng truncate (full text đã có trong `output/Script_N_<ts>.txt`).

→ Log file luôn nhỏ gọn, dễ đọc, không phình to gấp N² lần khi script nhiều part.

### Config

```yaml
log_requests: true       # default true. Set false để tắt logging.
log_dir:       "log"     # default "log". Set absolute hoặc relative path.
```

### Use case

- Debug khi output không như ý → mở log đối chiếu prompt thực tế đã build.
- Verify caching đang hit (xem prefix request 2+ có y hệt request 1).
- Verify multi-turn đang work (xem có turn assistant giữa các user turn).
- So sánh prompt giữa Anthropic vs DeepSeek (cùng config, output dùng provider khác nhau).

---

## 14. Anti-AI-detection (Human Voice rules)

YouTube đang phạt nội dung có dấu hiệu AI (**inauthentic content policy**). Tool tự động inject 1 block rules vào prompt mỗi request để model viết "như con người thật" — tránh markers AI rõ rệt.

### Rules được áp dụng

**Universal (mọi ngôn ngữ):**
- Không liệt kê máy móc ("Thứ nhất / Thứ hai / Thứ ba...").
- Đa dạng pattern câu kết (không lặp 3 câu liền cùng đuôi).
- Tránh connectives AI-typical (Moreover / Hơn nữa / さらに lạm dụng).
- Pha câu cụt + câu kéo dài, không hoàn hảo ngữ pháp 100%.
- Tránh số liệu tròn tuyệt đối ("100%", "đúng 10 lần").
- Cấm cụm dịch máy ("Điều đó nói rằng", "Bạn có biết không?", "Trong video hôm nay...").
- Tránh câu bị động kiểu dịch ("được X bởi Y").
- Thêm dấu vết con người: cảm thán ngắn, tự sửa giữa câu, chi tiết cảm giác cụ thể, số lẻ.
- **Nguyên tắc 70/30**: tuân thủ 70%, phá vỡ tự nhiên 30% — vì người thật không nhất quán.

**Language-specific:**
| Ngôn ngữ | Auto-detect | Có rule riêng |
|---|---|---|
| Japanese | "Japanese", "Nhật", "日本" | ✅ (文末 đa dạng, 接続詞 không lặp, 省略主語, tránh từ giới trẻ) |
| Vietnamese | "Vietnamese", "Việt" | ✅ (cấm cụm dịch máy + khẩu ngữ thay thế) |
| English | "English", "Anh" | ✅ (contractions, fragments, active voice, specific numbers) |
| Khác (Chinese, Korean…) | — | Universal only |

### Config

```yaml
human_voice: true                 # default true. Set false để tắt.
human_voice_extra: |              # optional — thêm rule custom cho batch này
  Tránh dùng từ "lương hưu" lặp quá 5 lần. Dùng synonym: "tiền hưu", "khoản trợ cấp".
  Tránh số tròn "30 triệu yên" — dùng "khoảng 28 triệu" hoặc "27 triệu rưỡi".
```

### Vị trí trong prompt

Block rules nằm trong **cached system header** — gắn sau Persona DNA, trước TTS clean rules:

```
=== PERSONA DNA ===
...
=== END PERSONA DNA ===

REQ: ...
OUTPUT LANGUAGE: Japanese.

=== HUMAN VOICE RULES (anti AI-detection) ===
[universal + japanese-specific + extra]
=== END HUMAN VOICE RULES ===

TTS CLEAN RULES (apply to EVERY part):
...
```

→ Cached prefix → áp dụng mọi part, mọi script, không tốn token lặp.

### Mở rộng

Thêm ngôn ngữ mới: edit `src/human_voice.py`:
1. Thêm constant `KOREAN_RULES = """..."""` với block do/don't tương tự.
2. Thêm key vào `LANGUAGE_RULES` dict.
3. Thêm hint vào `_LANG_HINTS` để auto-detect.

---

## 15. Output formatting (TTS-ready line breaks)

TTS engine cần input format đúng để pause / nhịp đọc tự nhiên. Tool inject 1 block **OUTPUT FORMATTING** vào cached prompt header — auto theo `output_language`, override được per-batch.

### Default cho Japanese

```
- Mỗi câu kết thúc bằng 「。」「？」「！」 → xuống dòng ngay sau dấu chấm.
- Câu chứa lời thoại trong dấu 「...」 → giữ trên 1 dòng (không ngắt giữa câu thoại).
- Câu mô tả / nội tâm / chuyển cảnh → mỗi câu 1 dòng.
- KHÔNG nối nhiều câu trên cùng 1 dòng bằng dấu phẩy / 「、」.
```

Ví dụ output đúng:
```
朝の光が薄く差し込んでいた。
窓の外には小さな庭が見える。
田中さんは静かに呟いた、「もう、こんな時間か」。
コーヒーの香ばしい匂いが部屋にゆっくりと広がっていった。
```

→ Câu mô tả mỗi dòng 1 câu, câu chứa hội thoại 「もう、こんな時間か」 giữ nguyên 1 dòng.

### Config

```yaml
output_format: "auto"      # default — universal + language default
output_format: "off"       # tắt hẳn block format
output_format: |           # override custom — replace toàn bộ default
  - Mỗi đoạn cách nhau 1 dòng trống.
  - Câu hỏi tu từ đứng riêng 1 dòng.
  - Số liệu phải viết bằng chữ ("hai mươi triệu yên"), không viết số.
```

### Auto-detect ngôn ngữ

| `output_language` chứa | Block format dùng |
|---|---|
| "Japanese" / "Nhật" / "日本" | Japanese (sentence-per-line, dialogue intact) |
| "Vietnamese" / "Việt" | Vietnamese |
| "English" / "Anh" | English |
| Khác | Universal only |

### Vị trí trong prompt

Block format nằm cuối cached header, sau TTS clean rules:

```
=== PERSONA DNA ===          ← cố định cho channel
=== HUMAN VOICE RULES ===    ← anti AI-detection
TTS CLEAN RULES              ← bỏ markdown / list / speaker label
=== OUTPUT FORMATTING ===    ← line breaks / paragraph
```

→ Tất cả trong cache → áp dụng mọi part, mọi script. Cost không đáng kể.

### Mở rộng

Thêm format default cho ngôn ngữ mới: edit `src/output_format.py`:
1. Thêm constant `KOREAN_FORMAT = """..."""`.
2. Thêm vào `LANGUAGE_FORMATS` dict.
3. Thêm hint vào `_LANG_HINTS`.

---

## 16. Roadmap

- [ ] SEO Metadata generator (Title + Description chuẩn YouTube)
- [ ] Resume khi gặp lỗi giữa batch
- [ ] Token usage report cuối mỗi batch
- [ ] Multi-topic batch (1 YAML → nhiều topic)
