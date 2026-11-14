"""Packaging regression tests with fake Mac tools, not native Mac acceptance."""
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from test_mac_scripts import executable

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bundle_assets", REPO / "scripts/verify-bundle-assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def inputs(root):
    (root / "clip_factory").mkdir(parents=True)
    (root / "clip_factory/inference_worker.py").write_text("# standalone worker\n")
    (root / "frontend/dist/assets").mkdir(parents=True)
    (root / "frontend/dist/index.html").write_text("<html>built UI</html>")
    (root / "frontend/dist/assets/main.js").write_text("console.log('built');")


def bundle(root, target):
    package = target / "Contents/Resources/clip_factory"
    package.mkdir(parents=True)
    shutil.copy(root / "clip_factory/inference_worker.py", package)
    shutil.copytree(root / "frontend/dist", package / "ui")
    return package


def test_bundle_assets_include_worker_and_nested_frontend(tmp_path):
    inputs(tmp_path)
    app = tmp_path / "Clip Factory.app"
    bundle(tmp_path, app)
    assets.verify(app, tmp_path)


@pytest.mark.parametrize("file", ["inference_worker.py", "ui/index.html", "ui/assets/main.js"])
@pytest.mark.parametrize("failure", ["missing", "stale"])
def test_bundle_assets_fail_closed(tmp_path, file, failure):
    inputs(tmp_path)
    app = tmp_path / "Clip Factory.app"
    package = bundle(tmp_path, app)
    target = package / file
    if failure == "missing":
        target.unlink()
    else:
        target.write_text("stale content")
    with pytest.raises(RuntimeError, match="missing or has stale"):
        assets.verify(app, tmp_path)


@pytest.mark.parametrize("omit_worker", [False, True])
def test_build_script_freezes_actual_data_before_archiving(tmp_path, omit_worker):
    root = tmp_path / "Checkout with spaces"
    inputs(root)
    (root / "scripts").mkdir()
    for name in ("build-mac-app.sh", "verify-bundle-assets.py"):
        shutil.copy(REPO / "scripts" / name, root / "scripts")
    # Catch stale package UI leaking into the build.
    (root / "clip_factory/ui").mkdir()
    (root / "clip_factory/ui/stale.js").touch()
    tools = tmp_path / "tools"
    log = tmp_path / "commands.txt"
    executable(tools / "uname", 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi\n')
    executable(tools / "npm", 'printf "npm %s\\n" "$*" >> "$OUTPUT"\n')
    executable(tools / "python", '''
for arg in "$@"; do printf '%s\\n' "$arg" >> "$OUTPUT"; done
if [[ "$1" == -m && "$2" == PyInstaller ]]; then
  destination="$PWD/dist/Clip Factory.app/Contents/Resources/clip_factory"
  mkdir -p "$destination"
  cp -R clip_factory/ui "$destination/ui"
  if [[ "$OMIT_WORKER" == 0 ]]; then cp clip_factory/inference_worker.py "$destination/"; fi
elif [[ "$1" == */verify-bundle-assets.py ]]; then
  "$REAL_PYTHON" "$@"
fi
''')
    # /usr/bin/ditto is an absolute native tool; rewrite only the fixture copy.
    script = root / "scripts/build-mac-app.sh"
    script.write_text(script.read_text().replace("/usr/bin/ditto", '"$DITTO"'))
    executable(tools / "ditto", 'printf "ditto\\n" >> "$OUTPUT"\ntouch "${@: -1}"\n')
    result = subprocess.run(
        ["bash", str(script)], cwd=tmp_path,
        env={**os.environ, "PATH": f"{tools}:/usr/bin:/bin", "PYTHON": str(tools / "python"),
             "REAL_PYTHON": sys.executable, "OUTPUT": str(log), "DITTO": str(tools / "ditto"),
             "OMIT_WORKER": str(int(omit_worker))},
        capture_output=True, text=True, check=False,
    )
    calls = log.read_text().splitlines()
    assert calls.index("npm ci") < calls.index("npm run build") < calls.index("PyInstaller")
    assert "pytest" in calls
    for data in (f"{root}/clip_factory/inference_worker.py:clip_factory",
                 f"{root}/clip_factory/ui:clip_factory/ui"):
        assert data in calls
        assert calls[calls.index(data) - 1] == "--add-data"
    assert not (root / "clip_factory/ui/stale.js").exists()
    archive = root / "dist/clip-factory-mac-arm64.zip"
    if omit_worker:
        assert result.returncode != 0
        assert "missing or has stale" in result.stderr
        assert "ditto" not in calls
        assert not archive.exists()
    else:
        assert result.returncode == 0, result.stderr
        assert calls.index(str(root / "scripts/verify-bundle-assets.py")) < calls.index("ditto")
        assert archive.is_file()
