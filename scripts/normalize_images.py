#!/usr/bin/env python3
"""Chuẩn hóa ảnh cho video 16:9 bằng FFmpeg mà không ghi đè file gốc.

Mặc định, mỗi ảnh được scale Lanczos, center-crop và xuất JPEG 1920x1080
yuv420p. Cấu trúc thư mục con được giữ nguyên; file đã có sẽ được bỏ qua
trừ khi dùng --force.

Ví dụ Windows:
  python scripts/normalize_images.py ^
    --in "D:/Materials/Ảnh/Prayer2" ^
    --out "D:/Materials/Ảnh/Prayer2_1920x1080"

Với hiệu ứng zoom, có thể chuẩn hóa 4K để giữ thêm chi tiết:
  python scripts/normalize_images.py --in INPUT --out OUTPUT --width 3840 --height 2160
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def build_cmd(src: Path, dst: Path, args: argparse.Namespace) -> list[str]:
    video_filter = (
        f"scale={args.width}:{args.height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={args.width}:{args.height},setsar=1,format=yuvj420p"
    )
    return [
        args.ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-map",
        "0:v:0",
        "-vf",
        video_filter,
        "-frames:v",
        "1",
        "-q:v",
        str(args.quality),
        "-map_metadata",
        "-1",
        "-f",
        "image2",
        "-update",
        "1",
        str(dst),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--in", dest="indir", required=True, type=Path)
    parser.add_argument("--out", dest="outdir", required=True, type=Path)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument(
        "--quality", type=int, default=2,
        help="Chất lượng JPEG của FFmpeg, 2=rất cao; phạm vi 2-31",
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--force", action="store_true", help="Ghi đè output đã có")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if shutil.which(args.ffmpeg) is None:
        raise SystemExit(f"Không tìm thấy ffmpeg trên PATH ({args.ffmpeg!r})")
    if not args.indir.is_dir():
        raise SystemExit(f"Thư mục input không tồn tại: {args.indir}")
    if args.width <= 0 or args.height <= 0 or args.width % 2 or args.height % 2:
        raise SystemExit("Width/height phải là số dương chẵn")
    if not 2 <= args.quality <= 31:
        raise SystemExit("Quality phải nằm trong khoảng 2-31")
    if args.indir.resolve() == args.outdir.resolve():
        raise SystemExit("Output phải khác input để bảo vệ ảnh gốc")

    files = sorted(
        file for file in args.indir.rglob("*")
        if file.is_file() and file.suffix.lower() in IMAGE_EXTS
    )
    if not files:
        raise SystemExit(f"Không có ảnh hợp lệ trong {args.indir}")

    print(
        f"Tìm thấy {len(files)} ảnh. Chuẩn hóa center-crop -> "
        f"{args.width}x{args.height}, JPEG quality {args.quality}."
    )
    ok = skipped = failed = 0
    used_destinations: set[Path] = set()
    for index, src in enumerate(files, 1):
        relative = src.relative_to(args.indir)
        dst = (args.outdir / relative).with_suffix(".jpg")
        if dst in used_destinations:
            dst = dst.with_name(f"{dst.stem}-{src.suffix.lower().lstrip('.')}.jpg")
        used_destinations.add(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)

        if dst.exists() and not args.force:
            print(f"[{index}/{len(files)}] SKIP: {relative}")
            skipped += 1
            continue

        temporary = dst.with_name(f".{dst.stem}.part.jpg")
        temporary.unlink(missing_ok=True)
        print(f"[{index}/{len(files)}] {relative} -> {dst.relative_to(args.outdir)}", flush=True)
        result = subprocess.run(
            build_cmd(src, temporary, args),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode == 0 and temporary.exists() and temporary.stat().st_size > 0:
            temporary.replace(dst)
            ok += 1
        else:
            temporary.unlink(missing_ok=True)
            failed += 1
            print(f"    LỖI: {result.stdout[-800:].strip()}")

    print(f"\nXong: {ok} ok, {skipped} bỏ qua, {failed} lỗi. Output: {args.outdir}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
