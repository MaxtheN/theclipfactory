"""Packaging regression tests with fake Mac tools, not native Mac acceptance."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import zipfile
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
    (root / "clip_factory/cloud_config.json").write_text('{"publishable_key":"public-fixture"}')
    (root / "clip_factory/demo_ui").mkdir()
    for name in ("index.html", "app.js", "styles.css"):
        (root / "clip_factory/demo_ui" / name).write_text("demo source " + name)
    (root / "clip_factory/fonts").mkdir()
    (root / "clip_factory/fonts/LiberationSans-Regular.ttf").write_bytes(b"font fixture")
    (root / "frontend/dist/assets").mkdir(parents=True)
    (root / "frontend/dist/index.html").write_text("<html>built UI</html>")
    (root / "frontend/dist/assets/main.js").write_text("console.log('built');")


def bundle(root, target):
    package = target / "Contents/Resources/clip_factory"
    package.mkdir(parents=True)
    shutil.copy(root / "clip_factory/inference_worker.py", package)
    shutil.copytree(root / "frontend/dist", package / "ui")
    shutil.copy(root / "clip_factory/cloud_config.json", package)
    shutil.copytree(root / "clip_factory/demo_ui", package / "demo_ui")
    shutil.copytree(root / "clip_factory/fonts", package / "fonts")
    return package


def test_bundle_assets_include_worker_and_nested_frontend(tmp_path):
    inputs(tmp_path)
    app = tmp_path / "Growth Factory.app"
    bundle(tmp_path, app)
    assets.verify(app, tmp_path)


@pytest.mark.parametrize("file", ["inference_worker.py", "ui/index.html", "ui/assets/main.js",
                                 "cloud_config.json", "demo_ui/index.html", "demo_ui/app.js", "demo_ui/styles.css",
                                  "fonts/LiberationSans-Regular.ttf"])
@pytest.mark.parametrize("failure", ["missing", "stale"])
def test_bundle_assets_fail_closed(tmp_path, file, failure):
    inputs(tmp_path)
    app = tmp_path / "Growth Factory.app"
    package = bundle(tmp_path, app)
    target = package / file
    if failure == "missing":
        target.unlink()
    else:
        target.write_text("stale content")
    with pytest.raises(RuntimeError, match="missing or has stale"):
        assets.verify(app, tmp_path)


@pytest.mark.parametrize("omit_worker", [False, True])
@pytest.mark.skipif(sys.platform == "win32", reason="runs the macOS bash build script")
def test_build_script_freezes_actual_data_before_archiving(tmp_path, omit_worker):
    root = tmp_path / "Checkout with spaces"
    inputs(root)
    (root / "scripts").mkdir()
    for name in ("build-mac-app.sh", "verify-bundle-assets.py", "write-release-manifest.py", "smoke-headless.py"):
        shutil.copy(REPO / "scripts" / name, root / "scripts")
    # Catch stale package UI leaking into the build.
    (root / "clip_factory/ui").mkdir()
    (root / "clip_factory/ui/stale.js").touch()
    tools = tmp_path / "tools"
    log = tmp_path / "commands.txt"
    executable(tools / "uname", 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi\n')
    executable(tools / "npm", 'printf "npm %s\\n" "$*" >> "$OUTPUT"\n')
    executable(tools / "bin/python", '''
for arg in "$@"; do printf '%s\\n' "$arg" >> "$OUTPUT"; done
if [[ "$1" == -m && "$2" == PyInstaller ]]; then
  destination="$PWD/dist/Growth Factory.app/Contents/Resources/clip_factory"
  mkdir -p "$destination"
  cp -R frontend/dist "$destination/ui"
  cp -R clip_factory/demo_ui "$destination/demo_ui"
  cp -R clip_factory/fonts "$destination/fonts"
  cp clip_factory/cloud_config.json "$destination/"
  if [[ "$OMIT_WORKER" == 0 ]]; then cp clip_factory/inference_worker.py "$destination/"; fi
elif [[ "$1" == */verify-bundle-assets.py || "$1" == */write-release-manifest.py ]]; then
  "$REAL_PYTHON" "$@"
fi
''')
    # /usr/bin/ditto is an absolute native tool; rewrite only the fixture copy.
    script = root / "scripts/build-mac-app.sh"
    script.write_text(script.read_text().replace("/usr/bin/ditto", '"$DITTO"').replace("/usr/bin/codesign", '"$CODESIGN"'))
    executable(tools / "ditto", '''printf "ditto\\n" >> "$OUTPUT"
"$REAL_PYTHON" -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("Growth Factory.app/Contents/Info.plist","fixture"); z.close()' "${@: -1}"
''')
    executable(tools / "codesign", 'printf "codesign\\n" >> "$OUTPUT"\n')
    result = subprocess.run(
        ["bash", str(script)], cwd=tmp_path,
        env={**os.environ, "PATH": f"{tools}:/usr/bin:/bin", "PYTHON": str(tools / "bin/python"), "GF_PACKAGE_VENV": str(tools),
             "REAL_PYTHON": sys.executable, "OUTPUT": str(log), "DITTO": str(tools / "ditto"),
             "OMIT_WORKER": str(int(omit_worker)), "CODESIGN": str(tools / "codesign")},
        capture_output=True, text=True, check=False,
    )
    calls = log.read_text().splitlines()
    assert calls.index("npm ci") < calls.index("npm run build") < calls.index("PyInstaller")
    assert "pytest" in calls
    for data in (f"{root}/clip_factory/inference_worker.py:clip_factory",
                 f"{root}/frontend/dist:clip_factory/ui", f"{root}/clip_factory/demo_ui:clip_factory/demo_ui",
                 f"{root}/clip_factory/fonts:clip_factory/fonts"):
        assert data in calls
        assert calls[calls.index(data) - 1] == "--add-data"
    assert (root / "clip_factory/ui/stale.js").exists(), "Packaging must never erase source UI directories"
    archive = root / "dist/growth-factory-mac-arm64.zip"
    if omit_worker:
        assert result.returncode != 0
        assert "missing or has stale" in result.stderr
        assert "ditto" not in calls
        assert not archive.exists()
    else:
        assert result.returncode == 0, result.stderr
        assert calls.index(str(root / "scripts/verify-bundle-assets.py")) < calls.index("ditto")
        assert calls.index(str(root / "scripts/smoke-headless.py")) < calls.index("ditto")
        assert archive.is_file()
        record = json.loads(archive.with_suffix(".manifest.json").read_text())
        assert record["app_bundle"] == "Growth Factory.app" and record["signing"] == "ad_hoc_verified"
        assert record["release_published"] is False and record["download_url"] is None
        assert record["headless_bootstrap_and_demo_assets"] == "verified"
        with zipfile.ZipFile(archive) as zipped:
            assert zipped.testzip() is None
