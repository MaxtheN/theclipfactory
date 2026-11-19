#!/bin/bash
# Build a local ad-hoc Apple Silicon artifact. No release upload or notarization is implied.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Build on native Apple Silicon macOS.' >&2; exit 1; }
BOOTSTRAP_PYTHON="${PYTHON:-python3}"
"$BOOTSTRAP_PYTHON" -c 'import platform; assert platform.machine() == "arm64"'
PACKAGE_VENV="${GF_PACKAGE_VENV:-$ROOT/build/packaging-venv}"
if [[ ! -x "$PACKAGE_VENV/bin/python" ]]; then
  "$BOOTSTRAP_PYTHON" -m venv "$PACKAGE_VENV"
fi
PACKAGE_PYTHON="$PACKAGE_VENV/bin/python"
"$PACKAGE_PYTHON" -c 'import platform; assert platform.machine() == "arm64"'
"$PACKAGE_PYTHON" -m pip install --disable-pip-version-check '.[desktop,test]' 'pyinstaller>=6.12,<7' 'setuptools>=75' wheel
(cd frontend && npm ci && npm run build)
test -f frontend/dist/index.html
test -f clip_factory/inference_worker.py
test -f clip_factory/demo_ui/index.html
test -f clip_factory/fonts/LiberationSans-Regular.ttf
# Run bounded checks separately; the normal development test pass owns the broader suite.
for test_file in scripts/tests/test_packaging.py tests/test_demo_loop.py; do
  "$PACKAGE_PYTHON" -m pytest "$test_file" -q
done
# FFmpeg is not bundled: the available static builds are not redistributable. Users install it
# (`brew install ffmpeg`); the app finds Homebrew's copy even with a bare launch PATH.
# Freeze source assets directly; never erase clip_factory/ui or other tracked source material.
# Model weights and inference runtime packages are installed separately by the app.
"$PACKAGE_PYTHON" -m PyInstaller --noconfirm --clean --windowed --name 'Growth Factory' \
  --osx-bundle-identifier ai.clipfactory.desktop \
  --paths "$ROOT" \
  --add-data "$ROOT/frontend/dist:clip_factory/ui" \
  --add-data "$ROOT/clip_factory/demo_ui:clip_factory/demo_ui" \
  --add-data "$ROOT/clip_factory/fonts:clip_factory/fonts" \
  --add-data "$ROOT/clip_factory/inference_worker.py:clip_factory" \
  --add-data "$ROOT/clip_factory/cloud_config.json:clip_factory" \
  --collect-all webview --collect-all keyring --copy-metadata keyring --collect-all uvicorn \
  --collect-submodules clip_factory --collect-submodules platformdirs \
  --hidden-import clip_factory.app --hidden-import clip_factory.main \
  --hidden-import Foundation --hidden-import AppKit --hidden-import WebKit \
  --hidden-import Vision --hidden-import CoreML --hidden-import Quartz \
  --distpath "$ROOT/dist" --workpath "$ROOT/build/pyinstaller" --specpath "$ROOT/build" \
  "$ROOT/scripts/desktop-entry.py"
"$PACKAGE_PYTHON" "$ROOT/scripts/verify-bundle-assets.py" "$ROOT/dist/Growth Factory.app"
/usr/bin/codesign --verify --deep --strict "$ROOT/dist/Growth Factory.app"
"$PACKAGE_PYTHON" "$ROOT/scripts/smoke-headless.py" --executable "$ROOT/dist/Growth Factory.app/Contents/MacOS/Growth Factory"
# ditto retains bundle symlinks and resource metadata.
/usr/bin/ditto -c -k --sequesterRsrc --keepParent 'dist/Growth Factory.app' dist/growth-factory-mac-arm64.zip
"$PACKAGE_PYTHON" "$ROOT/scripts/write-release-manifest.py" "$ROOT/dist/growth-factory-mac-arm64.zip" --root "$ROOT" --signature-verified --headless-verified
printf '%s\n' 'Built dist/Growth Factory.app and dist/growth-factory-mac-arm64.zip (ad-hoc; not notarized or published).'
