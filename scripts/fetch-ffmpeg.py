"""Fetch the FFmpeg and ffprobe bundled in the Windows and Linux apps.

The builds come from BtbN/FFmpeg-Builds: static GPL builds that include libass (burned-in captions)
and libx264 (the engine's encoder). The newest stable release line is chosen, the archive is checked
against the release's published SHA-256 list, and only ffmpeg, ffprobe and the licence are kept.
FFmpeg runs as a separate program, so shipping it next to the app is plain aggregation; its GPL
licence and a source notice are written beside it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

RELEASE_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest"
SOURCE = "https://github.com/BtbN/FFmpeg-Builds"
PLATFORMS = {"windows": "win64", "linux": "linux64"}
ASSET = re.compile(r"^ffmpeg-n(?P<major>\d+)\.(?P<minor>\d+)-latest-(?P<platform>win64|linux64)-gpl-"
                   r"(?P=major)\.(?P=minor)\.(?:zip|tar\.xz)$")
TOOLS = ("ffmpeg", "ffprobe")


def host_target() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform.startswith("linux"):
        return "linux"
    raise SystemExit("FFmpeg is bundled only in the Windows and Linux apps.")


def choose_asset(names: list[str], target: str) -> str:
    """The newest stable GPL build for the target; master snapshots and shared builds are skipped."""
    platform = PLATFORMS[target]
    matches = [(int(m["major"]), int(m["minor"]), name)
               for name in names if (m := ASSET.match(name)) and m["platform"] == platform]
    if not matches:
        raise RuntimeError(f"No stable GPL FFmpeg build for {platform} in the latest BtbN release.")
    return max(matches)[2]


def parse_checksums(text: str) -> dict[str, str]:
    sums = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            sums[parts[1].lstrip("*")] = parts[0]
    return sums


def get(url: str) -> bytes:
    headers = {"User-Agent": "growth-factory-build"}
    if (token := os.environ.get("GITHUB_TOKEN")) and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    with urlopen(Request(url, headers=headers), timeout=300) as response:
        return response.read()


def extract(archive: Path, destination: Path, target: str) -> None:
    """Copy bin/ffmpeg, bin/ffprobe and LICENSE.txt out of the archive's single top-level folder."""
    suffix = ".exe" if target == "windows" else ""
    wanted = {f"bin/{tool}{suffix}": f"{tool}{suffix}" for tool in TOOLS} | {"LICENSE.txt": "FFMPEG-LICENSE.txt"}
    found = set()
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zipped:
            for info in zipped.infolist():
                inner = info.filename.split("/", 1)[-1]
                if inner in wanted:
                    (destination / wanted[inner]).write_bytes(zipped.read(info))
                    found.add(inner)
    else:
        with tarfile.open(archive) as tarred:
            for member in tarred.getmembers():
                inner = member.name.split("/", 1)[-1]
                if inner in wanted and member.isfile():
                    (destination / wanted[inner]).write_bytes(tarred.extractfile(member).read())
                    found.add(inner)
    if missing := sorted(set(wanted) - found):
        raise RuntimeError(f"FFmpeg archive is missing {', '.join(missing)}.")
    for tool in TOOLS:
        (destination / f"{tool}{suffix}").chmod(0o755)


def check_capabilities(ffmpeg: Path) -> None:
    """The bundled FFmpeg must burn captions (libass) and encode with libx264, as the engine does."""
    filters = subprocess.run([str(ffmpeg), "-hide_banner", "-filters"], capture_output=True, text=True,
                             timeout=60, check=True).stdout
    encoders = subprocess.run([str(ffmpeg), "-hide_banner", "-encoders"], capture_output=True, text=True,
                              timeout=60, check=True).stdout
    missing = [name for name, listing in ((" subtitles ", filters), (" ass ", filters), (" libx264 ", encoders))
               if name not in listing]
    if missing:
        raise RuntimeError(f"Bundled FFmpeg lacks {', '.join(n.strip() for n in missing)}.")


def fetch(target: str, destination: Path, cache: Path) -> dict:
    release = json.loads(get(RELEASE_API))
    assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
    name = choose_asset(list(assets), target)
    sums = parse_checksums(get(assets["checksums.sha256"]).decode()) if "checksums.sha256" in assets else {}
    if name not in sums:
        raise RuntimeError(f"{name} has no published SHA-256; refusing to bundle an unverified FFmpeg.")
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / name
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != sums[name]:
        archive.write_bytes(get(assets[name]))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != sums[name]:
        archive.unlink()
        raise RuntimeError(f"{name} does not match its published SHA-256.")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    extract(archive, destination, target)
    record = {"asset": name, "sha256": digest, "source": SOURCE, "release_published_at": release.get("published_at")}
    (destination / "FFMPEG-SOURCE.txt").write_text(
        "Growth Factory bundles FFmpeg and ffprobe, unmodified, as separate programs.\n"
        f"Build: {name} (SHA-256 {digest}) from {SOURCE}.\n"
        "FFmpeg is licensed under the GNU GPL version 3 or later in this build; see FFMPEG-LICENSE.txt.\n"
        f"Corresponding source: {SOURCE} (build scripts) and https://ffmpeg.org/download.html (FFmpeg).\n"
    )
    if target == host_target():
        check_capabilities(destination / ("ffmpeg.exe" if target == "windows" else "ffmpeg"))
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", choices=sorted(PLATFORMS), default=None)
    parser.add_argument("--dest", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path("build/ffmpeg-cache"))
    args = parser.parse_args()
    record = fetch(args.target or host_target(), args.dest, args.cache)
    print(f"FFmpeg {record['asset']} · SHA-256 {record['sha256']} → {args.dest}")
    print(json.dumps(record))


if __name__ == "__main__":
    main()
