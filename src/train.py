from __future__ import annotations

from pathlib import Path

from .ai_client import BaseClient, text_block


ANALYZE_INSTRUCTION = """You are a writing-style forensic analyst. Read the WRITING SAMPLES and the CHANNEL BRIEF below, then produce a comprehensive **Persona DNA** in Markdown.

The Persona DNA is a long-lived "writer profile" that another AI will read each time it writes a new script for this channel. It must be self-contained — every later script will be generated using only this document plus a topic. So be specific, prescriptive, and concrete (cite patterns you observed in the samples).

Produce EXACTLY the following Markdown sections, in this order:

# Persona
Who this writer is. Identity, perspective, life experience that shapes the voice.

# Target Audience
Who is reading/listening. Age, life stage, emotional needs, cultural background. Anchor this in the channel brief.

# Market & Output Language
Geographic / linguistic market. The exact language scripts must be written in.

# Focus
The thematic territory: what topics, life situations, emotional notes this channel covers.

# Style
A short label sentence (e.g. "Japanese realistic emotional storytelling").

# Tone
Emotional register, mood, attitude. Use adjectives.

# Writing Style
Sentence-level craft: word choice register, dialogue handling, level of formality, density of imagery, use of internal thought.

# Vocabulary
Recurring word choices, idioms, register, slang to use AND to avoid. Be concrete.

# Sentence Structure
Length patterns, rhythm, punctuation habits, paragraphing.

# POV / Narrator Voice
Person (1st/2nd/3rd), pronouns used by the narrator and how characters address each other, internal-vs-external balance.

# Hook Pattern
How the first 100-200 words of a script grab attention. Cite 2-3 hook openings observed in the samples (paraphrased) and extract the formula.

# Pacing & Retention Tactics
How the writer keeps the audience engaged through the middle: cliffhangers, mini-twists, foreshadowing, sentence-length variation, scene cuts. Be specific.

# Emotional Arc
The typical emotional curve from open to close (e.g. calm → disruption → struggle → healing → reflection). Note where peaks usually fall.

# Closing Pattern
How scripts end: reflection, life lesson, quote, gentle CTA, emotional release. Cite the pattern.

# Narrative Structure
Overall macro structure: act layout, scene transitions, plot mechanics, climax/twist placement.

# Do
Concrete rules a writer must follow. Bullet list.

# Don't
Hard bans. Bullet list. Include any cultural taboos or style violations.

---

REQUIREMENTS:
- Be PRESCRIPTIVE, not descriptive — write rules a model can follow, not vague observations.
- Cite samples briefly when useful (e.g. "as in sample 2, the opening sentence is a question").
- Resolve any conflict between samples and the channel brief in favor of the brief.
- Return ONLY the Markdown document. No preamble, no closing remarks."""


REFINE_INSTRUCTION = """You previously produced the Persona DNA below. Refine and upgrade it by incorporating the NEW SAMPLES (and any updated CHANNEL BRIEF) that follow. The new samples are deltas — patterns observed in OLDER samples are already distilled into the existing Persona DNA, so treat that document as the authoritative baseline.

Rules for refinement:
- Keep the EXACT same section structure.
- Merge insights — do not duplicate.
- Sharpen rules that the new samples reinforce.
- Add new rules the new samples reveal that the existing persona doesn't capture.
- Correct anything that conflicts with the latest brief.
- Do NOT remove rules from the existing persona just because the new samples don't demonstrate them — old rules remain valid unless explicitly contradicted.

Return ONLY the updated Markdown document. No preamble."""


def _read_samples_filtered(folder: Path, mtime_floor: float | None = None) -> list[tuple[str, str]]:
    """Read .txt samples. If mtime_floor set, only include files newer than it."""
    samples = []
    skipped = 0
    # Recursive — picks up .txt in subfolders too (e.g. samples/japan_senior/2025-Q4/foo.txt).
    for p in sorted(folder.rglob("*.txt")):
        if mtime_floor is not None and p.stat().st_mtime <= mtime_floor:
            skipped += 1
            continue
        # Use relative path as sample name so subfolder structure stays visible.
        try:
            rel_name = str(p.relative_to(folder)).replace("\\", "/")
        except ValueError:
            rel_name = p.name
        samples.append((rel_name, p.read_text(encoding="utf-8", errors="ignore")))
    if mtime_floor is not None and skipped:
        print(f"[train] Skipped {skipped} sample(s) already learned (older than persona md)")
    return samples


def _samples_to_text(samples: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"--- SAMPLE: {name}\n{content}" for name, content in samples)


def _load_brief(cfg: dict) -> str:
    brief = cfg.get("training_brief", "").strip()
    brief_file = cfg.get("training_brief_file")
    if brief_file and Path(brief_file).exists():
        brief = Path(brief_file).read_text(encoding="utf-8")
    return brief.strip()


def _resolve_sample_folder(cfg: dict, persona_path: Path, refine_mode: str) -> tuple[Path, float | None]:
    """Return (folder_to_read, mtime_floor).

    refine_mode:
      - "new_only"   : when persona exists → only files newer than persona mtime
      - "all"        : always read all files in sample_folder
      - "folder:PATH": read all files in custom subpath
    """
    sample_folder = Path(cfg["sample_folder"])

    if refine_mode.startswith("folder:"):
        custom = refine_mode.split(":", 1)[1].strip()
        target = Path(custom)
        if not target.is_absolute():
            target = sample_folder.parent / custom if "/" in custom else sample_folder / custom
        return target, None

    if refine_mode == "all":
        return sample_folder, None

    # default: new_only
    if persona_path.exists() and persona_path.stat().st_size > 0:
        return sample_folder, persona_path.stat().st_mtime
    return sample_folder, None


def train(cfg: dict, client: BaseClient) -> Path:
    persona_path = Path(cfg["persona_file"])
    persona_path.parent.mkdir(parents=True, exist_ok=True)

    refine_mode = cfg.get("refine_mode", "new_only")
    sample_folder, mtime_floor = _resolve_sample_folder(cfg, persona_path, refine_mode)

    if not sample_folder.exists():
        raise RuntimeError(f"Sample folder not found: {sample_folder}")

    samples = _read_samples_filtered(sample_folder, mtime_floor)
    brief = _load_brief(cfg)

    persona_exists = persona_path.exists() and persona_path.stat().st_size > 0

    if persona_exists and not samples:
        print(f"[train] No new samples to learn (refine_mode={refine_mode}). Persona unchanged.")
        return persona_path

    if not samples:
        raise RuntimeError(f"No .txt samples found in {sample_folder}")

    samples_text = _samples_to_text(samples)
    brief_block = (
        f"=== CHANNEL BRIEF ===\n{brief}\n\n"
        if brief
        else "=== CHANNEL BRIEF ===\n(none provided — infer everything from samples)\n\n"
    )

    if persona_exists:
        existing = persona_path.read_text(encoding="utf-8")
        print(f"[train] Refining persona {persona_path.name} with {len(samples)} new sample(s) [mode={refine_mode}]")
        prompt = (
            f"{REFINE_INSTRUCTION}\n\n"
            f"=== EXISTING PERSONA DNA ===\n{existing}\n\n"
            f"{brief_block}"
            f"=== NEW SAMPLES ===\n{samples_text}"
        )
    else:
        print(f"[train] Building new persona from {len(samples)} samples")
        prompt = f"{ANALYZE_INSTRUCTION}\n\n{brief_block}=== WRITING SAMPLES ===\n{samples_text}"

    result = client.complete(
        blocks=[text_block(prompt)],
        model=cfg["model_training"],
        max_tokens=cfg.get("max_tokens", 8000),
    )

    persona_path.write_text(result, encoding="utf-8")
    print(f"[train] Saved persona DNA -> {persona_path}")
    return persona_path
