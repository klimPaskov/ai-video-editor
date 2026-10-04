#!/usr/bin/env python3
"""Validate the supplied implementation workspace, never claim native app tests."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
from pathlib import Path
from urllib.parse import unquote
import re
from PIL import Image
from jsonschema import Draft202012Validator
from workspace_files import source_files, source_digest

ROOT = Path(__file__).resolve().parents[1]

def load(rel: str):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))

def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-integrity", action="store_true")
    args = parser.parse_args()
    meta = load("PACKAGE_METADATA.json")
    require(ROOT.name == "ai-video-editor", "Expected actual ai-video-editor working root")
    goal = (ROOT / "GOAL_PROMPT.md").read_text(encoding="utf-8")
    require(len(goal) < 4000, "Goal exceeds the under-4000-character limit")
    require(len(goal) == meta["goal_prompt_characters"], "Goal length metadata is stale")
    refs = load("docs/references/manifest.json")["references"]
    require(len(refs) == meta["reference_image_count"], "Reference count is stale")
    seen = set()
    declared = set()
    for ref in refs:
        p = ROOT / ref["path"]
        require(p.is_file(), f"Missing reference: {p}")
        require(p.suffix.lower() == ".png", f"Unexpected image type: {p}")
        require(ROOT.resolve() in p.resolve().parents, f"Outside-root path: {p}")
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        require(digest == ref["sha256"], f"Reference hash mismatch: {p}")
        require(digest not in seen, f"Duplicate reference: {p}")
        seen.add(digest)
        declared.add(p.resolve())
        with Image.open(p) as im:
            im.verify()
        with Image.open(p) as im:
            require(im.width >= 1500 and im.height >= 800, f"Small reference: {p}")
        require(not any(v in p.name.lower() for v in ("contact", "collage", "montage")), f"Combined-board reference: {p}")
    actual = {p.resolve() for p in (ROOT / "docs/references").rglob("*.png")}
    require(actual == declared, "Unlisted or missing reference images")
    for group, count in meta["reference_sets"].items():
        require(len(list((ROOT / "docs/references/screenshots" / group).glob("*.png"))) == count, f"Wrong count: {group}")
    gallery = (ROOT / "docs/references/index.html").read_text(encoding="utf-8")
    for ref in refs:
        require(ref["path"].removeprefix("docs/references/") in gallery, "Gallery omits a reference")
    for rel in ("AGENTS.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", ".github/workflows/spec-validation.yml", "docs/44_LOSSLESS_MEDIA_POLICY.md", "docs/45_OPEN_SOURCE_DEVELOPMENT.md", "docs/references/IMPLEMENTATION_NOTES.md"):
        require((ROOT / rel).is_file(), f"Missing required file: {rel}")
    for p in source_files(ROOT):
        require(not p.is_symlink(), f"Symlink: {p}")
        if p.is_file():
            require(p.suffix.lower() not in {".ttf", ".otf", ".woff", ".woff2", ".mp4", ".mov", ".mkv", ".wav", ".flac", ".exe", ".zip"}, f"Unexpected runtime/media binary: {p}")
    schema = load("docs/schemas/export_manifest.schema.json")
    val = Draft202012Validator(schema)
    baseline = load("docs/examples/export_manifest.example.json")
    share = load("docs/examples/export_share.example.json")
    val.validate(baseline)
    val.validate(share)
    failures = []
    def reject(label, section, field, value, base=baseline):
        doc = copy.deepcopy(base)
        if section:
            doc[section][field] = value
        else:
            doc[field] = value
        require(not val.is_valid(doc), f"Invalid export accepted: {label}")
        failures.append(label)
    reject("ProRes falsely called lossless", "profile", "video_codec", "prores_ks")
    reject("H264 falsely called lossless", "profile", "video_codec", "h264")
    reject("AAC in lossless master", "profile", "audio_codec", "aac")
    reject("MP4 used for default master", "profile", "container", "mp4")
    reject("Proxy used as export input", "quality_policy", "uses_preview_source", True)
    reject("Failed video equality", "lossless_verification", "video_samples_equal", False)
    reject("Failed audio equality", "lossless_verification", "audio_samples_equal", False)
    reject("Unverified decode", "", "decode_verified", False)
    reject("Compressed export without explicit choice", "quality_policy", "user_selected_lower_quality", False, share)
    reject("FLAC with floating samples", "profile", "audio_codec", "flac")
    checked = 0
    if args.check_integrity:
        path = ROOT / "MANIFEST.sha256"
        require(path.is_file(), "Integrity manifest missing")
        for line in path.read_text(encoding="utf-8").splitlines():
            digest, rel = line.split("  ", 1)
            p = ROOT / rel
            require(p.is_file(), f"Manifest file missing: {rel}")
            require(source_digest(p) == digest, f"Integrity mismatch: {rel}")
            checked += 1
    print(f"Goal characters: {len(goal)}")
    print(f"Original full-page reference images verified: {len(refs)}")
    print(f"Invalid quality contracts rejected: {len(failures)}")
    if args.check_integrity:
        print(f"Integrity entries verified: {checked}")
    print("Workspace checks passed. No native application or real Codex tests were run.")

if __name__ == "__main__":
    main()
