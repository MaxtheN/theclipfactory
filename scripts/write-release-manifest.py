"""Describe a local Mac archive honestly; never creates or uploads a GitHub release."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import zipfile
from datetime import UTC, datetime
from pathlib import Path


def git_value(root: Path, *args: str) -> str | None:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def manifest(archive: Path, root: Path, *, signature_verified: bool = False, headless_verified: bool = False) -> dict:
    with zipfile.ZipFile(archive) as zipped:
        if zipped.testzip() is not None or "Growth Factory.app/Contents/Info.plist" not in zipped.namelist():
            raise RuntimeError("Archive is corrupt or does not contain the named Growth Factory Mac bundle.")
    return {"artifact": archive.name, "app_bundle": "Growth Factory.app", "architecture": "arm64",
            "platform": "macOS", "bytes": archive.stat().st_size,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "built_at": datetime.now(UTC).isoformat(), "git_commit": git_value(root, "rev-parse", "HEAD"),
            "contains_uncommitted_changes": bool(git_value(root, "status", "--porcelain")),
            "archive_crc": "verified", "signing": "ad_hoc_verified" if signature_verified else "unverified",
            "headless_bootstrap_and_demo_assets": "verified" if headless_verified else "unverified",
            "notarized": False, "release_published": False, "download_url": None,
            "separate_prerequisites": ["FFmpeg and ffprobe with caption/font filters, available on PATH.",
                                       "Speech/model runtime setup inside the app before fresh production."],
            "limitations": ["Local development artifact; no Developer ID or notarization claim.",
                            "No clean-Mac installation or model-runtime acceptance is implied."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--signature-verified", action="store_true")
    parser.add_argument("--headless-verified", action="store_true")
    args = parser.parse_args()
    record = manifest(args.archive, args.root, signature_verified=args.signature_verified,
                      headless_verified=args.headless_verified)
    destination = args.archive.with_suffix(".manifest.json")
    destination.write_text(json.dumps(record, indent=2) + "\n")
    print(f"Local archive: {record['artifact']} · {record['bytes']} bytes · SHA-256 {record['sha256']}")
    print(f"Manifest: {destination.name} (not uploaded or notarized)")


if __name__ == "__main__":
    main()
