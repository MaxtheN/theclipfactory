"""Shell entry-point checks; fake macOS tools do not count as hardware acceptance."""
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/bash\nset -eu\n" + text)
    path.chmod(0o755)


def test_double_click_entrypoint_spaces_and_unrelated_cwd(tmp_path):
    root = tmp_path / "Checkout with spaces"
    root.mkdir()
    shutil.copy(REPO / "Start Clip Factory.command", root)
    (root / "frontend/dist").mkdir(parents=True)
    (root / "frontend/dist/index.html").touch()
    executable(root / ".venv/bin/clip-factory", 'printf "%s\\n" "$@" > "$OUTPUT"\n')
    output = tmp_path / "args.txt"
    result = subprocess.run(["bash", str(root / "Start Clip Factory.command"), "--headless",
                             "--data-dir", str(tmp_path / "Data with spaces")],
                            cwd=tmp_path, env={**os.environ, "OUTPUT": str(output)}, capture_output=True, check=False)
    assert result.returncode == 0
    assert output.read_text().splitlines() == ["--headless", "--data-dir", str(tmp_path / "Data with spaces")]


def test_setup_current_frontend_does_not_require_npm(tmp_path):
    root = tmp_path / "Checkout with spaces"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(REPO / "scripts/setup-mac.sh", root / "scripts")
    shutil.copy(REPO / "pyproject.toml", root)
    (root / "clip_factory").mkdir()
    for name in ("__init__.py", "inference_worker.py"):
        shutil.copy(REPO / "clip_factory" / name, root / "clip_factory")
    (root / "frontend/src").mkdir(parents=True)
    (root / "frontend/dist").mkdir()
    for name in ("package.json", "package-lock.json", "index.html", "vite.config.ts", "tsconfig.json"):
        (root / "frontend" / name).touch()
    index = root / "frontend/dist/index.html"
    index.write_text("built UI")
    # Force built UI newer even on coarse timestamp filesystems.
    os.utime(index, (index.stat().st_mtime + 2, index.stat().st_mtime + 2))
    tools = tmp_path / "tools"
    executable(tools / "uname", 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi\n')
    executable(tools / "python3.12", 'exit 0\n')
    executable(tools / "npm", 'echo unexpected-npm >&2; exit 99\n')
    executable(tools / "ffmpeg", 'exit 0\n')
    executable(tools / "ffprobe", 'exit 0\n')
    output = tmp_path / "python-calls.txt"
    executable(root / ".venv/bin/python", 'printf "%s|%s\\n" "$PWD" "$*" >> "$OUTPUT"\n')
    result = subprocess.run(["bash", str(root / "scripts/setup-mac.sh")], cwd=tmp_path,
                            env={**os.environ, "PATH": f"{tools}:/usr/bin:/bin", "OUTPUT": str(output)},
                            capture_output=True, check=False, text=True, stdin=subprocess.DEVNULL)
    assert result.returncode == 0, result.stderr
    assert "unexpected-npm" not in result.stderr
    assert (root / "clip_factory/ui/index.html").read_text() == "built UI"
    assert f"{root}|-m pip install -e .[desktop]" in output.read_text()
    # Build a real wheel from the setup fixture, without network or native deps.
    # The frozen external Python needs a physical worker file, not only bytecode.
    wheels = tmp_path / "wheels"
    wheels.mkdir()
    subprocess.run([sys.executable, "-c",
                    ("from setuptools.build_meta import build_wheel; "
                     f"build_wheel({str(wheels)!r})")], cwd=root, capture_output=True, check=True)
    with zipfile.ZipFile(next(wheels.glob("*.whl"))) as wheel:
        assert wheel.read("clip_factory/ui/index.html") == b"built UI"
        assert wheel.read("clip_factory/inference_worker.py") == (
            REPO / "clip_factory/inference_worker.py").read_bytes()


@pytest.mark.parametrize("name", ["setup-mac.sh", "build-mac-app.sh"])
def test_mac_scripts_reject_linux_before_installing(tmp_path, name):
    tools = tmp_path / "tools"
    executable(tools / "uname", 'echo Linux\n')
    result = subprocess.run(["bash", str(REPO / "scripts" / name)], cwd=tmp_path,
                            env={**os.environ, "PATH": f"{tools}:/usr/bin:/bin"}, capture_output=True, check=False, text=True)
    assert result.returncode == 1
    assert "macOS" in result.stderr


def test_missing_python_never_installs_without_confirmation(tmp_path):
    tools = tmp_path / "tools"
    executable(tools / "uname", 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi\n')
    executable(tools / "python3.12", 'exit 1\n')
    executable(tools / "python3.11", 'exit 1\n')
    executable(tools / "brew", 'touch "$OUTPUT"\n')
    output = tmp_path / "unexpected-install"
    result = subprocess.run(["bash", str(REPO / "scripts/setup-mac.sh")], cwd=tmp_path,
                            env={**os.environ, "PATH": f"{tools}:/usr/bin:/bin", "OUTPUT": str(output)},
                            capture_output=True, check=False, text=True, stdin=subprocess.DEVNULL)
    assert result.returncode == 1
    assert "Python 3.11 or 3.12 is required" in result.stderr
    assert not output.exists()
