#!/usr/bin/env python3
"""Match platform assets to merchant-owned masters without altering either file."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


MEDIA_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".jpg", ".jpeg", ".png", ".webp"}


def files_under(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_stem(path: Path) -> str:
    stem = path.stem.lower()
    stem = re.sub(r"(?:[-_ ](?:copy|download|douyin|qianchuan|抖音|千川|副本))+$", "", stem)
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", stem)


def build_index(paths: list[Path]) -> tuple[dict[str, list[Path]], dict[str, list[Path]]]:
    by_hash: dict[str, list[Path]] = {}
    by_name: dict[str, list[Path]] = {}
    for path in paths:
        by_hash.setdefault(sha256(path), []).append(path)
        by_name.setdefault(normalized_stem(path), []).append(path)
    return by_hash, by_name


def match(platform_root: Path, master_root: Path) -> dict:
    platform_files = files_under(platform_root)
    master_files = files_under(master_root)
    by_hash, by_name = build_index(master_files)
    matches = []
    for asset in platform_files:
        exact = by_hash.get(sha256(asset), [])
        candidates = by_name.get(normalized_stem(asset), [])
        if exact:
            status, selected = "exact_hash", exact
        else:
            same_size = [candidate for candidate in candidates if candidate.stat().st_size == asset.stat().st_size]
            if same_size:
                status, selected = "name_and_size", same_size
            elif candidates:
                status, selected = "name_candidate", candidates
            else:
                status, selected = "no_match", []
        matches.append({
            "platform_asset": str(asset.resolve()),
            "status": status,
            "owned_master_candidates": [str(path.resolve()) for path in selected],
            "requires_human_review": status != "exact_hash",
        })
    return {
        "platform_asset_count": len(platform_files),
        "owned_master_count": len(master_files),
        "matches": matches,
        "notice": "This tool only fingerprints and matches files. It does not detect, remove, decode, or bypass platform watermarks.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="将平台素材匹配回商家自有母版")
    parser.add_argument("platform_assets", type=Path)
    parser.add_argument("owned_masters", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = match(args.platform_assets, args.owned_masters)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
