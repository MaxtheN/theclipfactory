#!/bin/bash
# Interactive, opt-in dependency installation; never runs remote shell installers.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
cd "$ROOT"
fail() { printf '%s\n' "$*" >&2; exit 1; }
confirm() {
  local answer
  [[ -t 0 ]] || return 1
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]]
}
[[ "$(uname -s)" == Darwin ]] || fail 'This setup script requires macOS. Use documented browser/headless mode elsewhere.'
[[ "$(uname -m)" == arm64 ]] || fail 'Use a native Apple Silicon terminal (not Rosetta). This MVP targets Apple Silicon.'
PYTHON=""
for candidate in python3.12 python3.11; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import platform; assert platform.machine() == "arm64"' 2>/dev/null; then
    PYTHON="$(command -v "$candidate")"; break
  fi
done
if [[ -z "$PYTHON" ]]; then
  command -v brew >/dev/null 2>&1 || fail 'Install Homebrew using its official instructions, then run this script again. No remote installer is executed here.'
  confirm 'Install Python 3.12 using Homebrew?' || fail 'Python 3.11 or 3.12 is required. Install it, then rerun.'
  brew install python@3.12
  PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
fi
if [[ -e .venv ]]; then
  [[ -x .venv/bin/python ]] || fail '.venv is incomplete; move it aside and rerun setup.'
  .venv/bin/python -c 'import sys,platform; assert sys.version_info[:2] in ((3,11),(3,12)); assert platform.machine()=="arm64"' || fail 'Existing .venv must use native Python 3.11/3.12; move it aside and rerun.'
else
  "$PYTHON" -m venv .venv
fi
# Build only if dist is absent or tracked frontend inputs are newer.
if [[ ! -f frontend/dist/index.html ]] || [[ -n "$(find frontend/src frontend/package.json frontend/package-lock.json frontend/index.html frontend/vite.config.ts frontend/tsconfig.json -type f -newer frontend/dist/index.html -print -quit 2>/dev/null)" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    command -v brew >/dev/null 2>&1 || fail 'Install Node.js 22.12+ (npm included), then rerun setup.'
    confirm 'Install Node.js using Homebrew to build the frontend?' || fail 'Install Node.js 22.12+ with npm, then rerun.'
    brew install node
  fi
  (cd "$ROOT/frontend" && npm ci && npm run build)
fi
# UI package data is preferred over the repository dist fallback.
# The parent packaging configuration includes clip_factory/ui/* in wheels.
mkdir -p clip_factory/ui
cp -R frontend/dist/. clip_factory/ui/
.venv/bin/python -m pip install -e '.[desktop]'
# Burned-in captions need libass. Homebrew's default ffmpeg omits it; the keg-only
# ffmpeg-full formula includes it and the app prefers it automatically.
caption_ffmpeg() {
  [[ -x /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg || -x /usr/local/opt/ffmpeg-full/bin/ffmpeg ]] && return 0
  command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 &&
    ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles '
}
if ! caption_ffmpeg; then
  if command -v brew >/dev/null 2>&1 && confirm 'Install ffmpeg-full using Homebrew for rendering with burned-in captions?'; then
    brew install ffmpeg-full
  else
    printf '%s\n' 'FFmpeg with caption support (libass) not found. Install it with: brew install ffmpeg-full'
  fi
fi
printf '%s\n' 'Setup complete. Open Start Clip Factory.command, or run .venv/bin/clip-factory.' 'Models are not installed by setup. Review licenses and disk space in the app before downloading.'
