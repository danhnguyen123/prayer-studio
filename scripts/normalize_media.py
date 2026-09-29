#!/usr/bin/env python3
"""Chuẩn hoá thư viện footage cho Remotion: cắt <= N giây, ép CFR 30fps, H.264.

Vì sao cần: Remotion (Lambda) báo "No frame found at position ..." khi video nguồn
là VFR, fps lệch 30, hoặc metadata duration dài hơn số frame thật. Chuẩn hoá tất cả
footage về **CFR 30fps + độ dài <= 30s + H.264 + yuv420p** làm mọi clip đồng nhất và
mọi frame N luôn tồn tại tại N/30 giây.

- Cắt tối đa --max-seconds (mặc định 30s), tính từ đầu clip.
- Ép đúng --fps (mặc định 30) ở chế độ CFR (fps_mode=cfr) → không còn VFR.
- Bỏ audio (-an): footage phát muted trong video nên không cần, đồng thời xoá luôn
  trường hợp audio dài hơn video.
- Tuỳ chọn hạ chiều cao tối đa --height (mặc định 1080; video render 1080p nên 4K là
  phí dung lượng + chậm trên Lambda). --height 0 = giữ nguyên độ phân giải.
- Idempotent: bỏ qua file đã có ở output (trừ khi --force).

Usage:
  python normalize_media.py --in /mnt/media/video --out /mnt/media/video_norm
  python normalize_media.py --in "D:/Materials/Video 4K" --out "D:/Materials/Video 30s" --height 0
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}


def build_cmd(src: Path, dst: Path, args) -> list[str]:
    cmd = [
        args.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-t", str(args.max_seconds),
        "-map", "0:v:0",           # chỉ lấy luồng video đầu tiên
        "-an",                      # bỏ audio
        "-r", str(args.fps),
        "-fps_mode", "cfr",         # ép constant frame rate
        "-c:v", "libx264",
        "-preset", args.preset,
        "-crf", str(args.crf),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
    ]
    if args.height and args.height > 0:
        # Hạ về tối đa <height> px chiều cao, giữ tỉ lệ, chỉ downscale (không upscale).
        cmd += ["-vf", f"scale=-2:min({args.height}\\,ih)"]
    if args.maxrate and args.maxrate > 0:
        # Trần bitrate (VBV) → khống chế dung lượng file dù footage nhiều chuyển động.
        cmd += ["-maxrate", f"{args.maxrate}M", "-bufsize", f"{args.maxrate * 2}M"]
    cmd += [str(dst)]
    return cmd


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--in", dest="indir", required=True, type=Path)
    p.add_argument("--out", dest="outdir", required=True, type=Path)
    p.add_argument("--max-seconds", type=int, default=30)
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--height", type=int, default=1080,
                   help="Chiều cao tối đa (px); 0 = giữ nguyên độ phân giải")
    p.add_argument("--crf", type=int, default=20)
    p.add_argument("--maxrate", type=int, default=0,
                   help="Trần bitrate Mbps (VBV) để khống chế dung lượng; 0 = tắt")
    p.add_argument("--preset", default="medium")
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--force", action="store_true", help="Ghi đè file đã chuẩn hoá")
    args = p.parse_args()

    # In tiếng Việt được trên console Windows (cp1252) lẫn Linux (UTF-8).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if shutil.which(args.ffmpeg) is None:
        raise SystemExit(f"Không tìm thấy ffmpeg trên PATH ({args.ffmpeg!r})")
    if not args.indir.is_dir():
        raise SystemExit(f"Thư mục input không tồn tại: {args.indir}")
    args.outdir.mkdir(parents=True, exist_ok=True)

    files = sorted(
        f for f in args.indir.rglob("*")
        if f.is_file() and f.suffix.lower() in VIDEO_EXTS
    )
    if not files:
        raise SystemExit(f"Không có video trong {args.indir}")

    print(f"Tìm thấy {len(files)} video. Chuẩn hoá → {args.max_seconds}s, {args.fps}fps CFR"
          f"{'' if not args.height else f', <= {args.height}p'}, H.264 (crf {args.crf}).")

    ok, skipped, failed = 0, 0, 0
    for i, src in enumerate(files, 1):
        dst = args.outdir / (src.stem + ".mp4")
        if dst.exists() and not args.force:
            print(f"[{i}/{len(files)}] SKIP (đã có): {dst.name}")
            skipped += 1
            continue
        print(f"[{i}/{len(files)}] {src.name} -> {dst.name}", flush=True)
        result = subprocess.run(
            build_cmd(src, dst, args),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        if result.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            ok += 1
        else:
            failed += 1
            print(f"    LỖI: {result.stdout[-500:].strip()}")
            dst.unlink(missing_ok=True)

    print(f"\nXong: {ok} ok, {skipped} bỏ qua, {failed} lỗi. Output: {args.outdir}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
