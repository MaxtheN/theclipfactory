#!/bin/bash
# Build an unsigned/ad-hoc local artifact; not a signed or notarized release.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Build on native Apple Silicon macOS.' >&2; exit 1; }
PYTHON="${PYTHON:-python3}"
"$PYTHON" -c 'import platform; assert platform.machine() == "arm64"'
(cd frontend && npm ci && npm run build)
test -f frontend/dist/index.html
test -f clip_factory/inference_worker.py
rm -rf clip_factory/ui
mkdir -p clip_factory/ui
cp -R frontend/dist/. clip_factory/ui/
"$PYTHON" -m pip install '.[desktop,test]' 'pyinstaller>=6.12,<7' 'setuptools>=75' wheel
"$PYTHON" -m pytest tests scripts/tests -q
# Runtime model packages are deliberately not bundled. Parent installs an isolated venv later.
"$PYTHON" -m PyInstaller --noconfirm --clean --windowed --name 'Clip Factory' \
  --osx-bundle-identifier ai.clipfactory.desktop \
  --add-data "$ROOT/clip_factory/ui:clip_factory/ui" \
  --add-data "$ROOT/clip_factory/inference_worker.py:clip_factory" \
  --add-data "$ROOT/clip_factory/cloud_config.json:clip_factory" \
  --collect-all webview --collect-all keyring --collect-all uvicorn \
  --collect-submodules clip_factory --collect-submodules platformdirs \
  --hidden-import clip_factory.app --hidden-import clip_factory.main \
  --hidden-import Foundation --hidden-import AppKit --hidden-import WebKit \
  --hidden-import Vision --hidden-import CoreML --hidden-import Quartz \
  --distpath "$ROOT/dist" --workpath "$ROOT/build" --specpath "$ROOT/build" \
  "$ROOT/scripts/desktop-entry.py"
"$PYTHON" "$ROOT/scripts/verify-bundle-assets.py" "$ROOT/dist/Clip Factory.app"
# PyInstaller supplies ad-hoc signing on arm64 without a developer certificate.
# ditto retains bundle symlinks/metadata; uploaded ZIP is a CI artifact, not a release.
/usr/bin/ditto -c -k --sequesterRsrc --keepParent 'dist/Clip Factory.app' dist/clip-factory-mac-arm64.zip
printf '%s\n' 'Built dist/Clip Factory.app (ad-hoc, not notarized) and CI archive.'
