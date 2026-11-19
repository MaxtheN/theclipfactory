#!/bin/bash
# Source setup for Linux x64: interactive, opt-in dependency installation; never runs remote shell installers.
# Creators who only want to run the app should use the AppImage instead (see README).
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { printf '%s\n' "$*" >&2; exit 1; }
confirm() {
  local answer
  [[ -t 0 ]] || return 1
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]]
}
[[ "$(uname -s)" == Linux ]] || fail 'This setup script is for Linux. Use scripts/setup-mac.sh or scripts/setup-windows.ps1 elsewhere.'
[[ "$(uname -m)" == x86_64 ]] || fail 'Growth Factory supports Linux on x64 only.'
# Package names below are for Debian and Ubuntu; other distributions name them similarly.
apt_install() {
  command -v apt-get >/dev/null 2>&1 || return 1
  confirm "Install $* with apt (needs sudo)?" || return 1
  sudo apt-get install -y "$@"
}
PYTHON=""
for candidate in python3.12 python3.11 python3.13; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import venv' 2>/dev/null; then
    PYTHON="$(command -v "$candidate")"; break
  fi
done
if [[ -z "$PYTHON" ]]; then
  apt_install python3 python3-venv || fail 'Python 3.11, 3.12 or 3.13 with venv is required. Install it, then rerun.'
  PYTHON="$(command -v python3)"
fi
if [[ -e .venv ]]; then
  [[ -x .venv/bin/python ]] || fail '.venv is incomplete; move it aside and rerun setup.'
  .venv/bin/python -c 'import sys; assert sys.version_info[:2] in ((3,11),(3,12),(3,13))' || fail 'Existing .venv must use Python 3.11-3.13; move it aside and rerun.'
else
  "$PYTHON" -m venv .venv
fi
# Build only if dist is absent or tracked frontend inputs are newer.
if [[ ! -f frontend/dist/index.html ]] || [[ -n "$(find frontend/src frontend/package.json frontend/package-lock.json frontend/index.html frontend/vite.config.ts frontend/tsconfig.json -type f -newer frontend/dist/index.html -print -quit 2>/dev/null)" ]]; then
  command -v npm >/dev/null 2>&1 || fail 'Install Node.js 22.12+ (npm included), for example from nodejs.org or your package manager, then rerun.'
  (cd "$ROOT/frontend" && npm ci && npm run build)
fi
# UI package data is preferred over the repository dist fallback.
mkdir -p clip_factory/ui
cp -R frontend/dist/. clip_factory/ui/
# The app window uses pywebview's Qt backend (Qt WebEngine from pip), so no WebKitGTK is needed.
.venv/bin/python -m pip install -e '.[desktop]' 'pywebview[qt]>=5,<7'
# MediaPipe face detection loads EGL and GLES.
if ! ldconfig -p 2>/dev/null | grep -q 'libEGL.so.1'; then
  apt_install libegl1 libgles2 || printf '%s\n' 'Face-follow needs libEGL and libGLES (Debian/Ubuntu: sudo apt install libegl1 libgles2).'
fi
# Burned-in captions need FFmpeg built with libass; most distribution packages include it.
caption_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 &&
    ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles '
}
if ! caption_ffmpeg; then
  apt_install ffmpeg || printf '%s\n' 'FFmpeg with caption support (libass) not found. Install it with your package manager, for example: sudo apt install ffmpeg'
fi
printf '%s\n' 'Setup complete. Run .venv/bin/clip-factory to open Growth Factory (or add --browser to use your browser).' \
  'Models are not installed by setup. Review licenses and disk space in the app before downloading.'
