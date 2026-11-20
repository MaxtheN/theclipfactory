"""Build the unsigned Windows installer or Linux AppImage on the matching x64 machine.

Windows: dist/growth-factory-windows-x64-setup.exe (Inno Setup; checks for WebView2).
Linux:   dist/growth-factory-linux-x86_64.AppImage (Qt WebEngine window, no WebKitGTK needed).

Both bundle FFmpeg with libass, the caption font and the face models, are checked with the headless
smoke test, and get a local manifest. Nothing is signed, uploaded or published. The Mac app keeps
scripts/build-mac-app.sh.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
WEBVIEW2_BOOTSTRAPPER = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
APPIMAGETOOL = "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
INNO_DEFAULT = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Inno Setup 6" / "ISCC.exe"
TARGETS = {
    "windows": {"bundle": "Growth Factory", "cli": "growth-factory-cli.exe",
                "artifact": "growth-factory-windows-x64-setup.exe"},
    "linux": {"bundle": "growth-factory", "cli": "growth-factory",
              "artifact": "growth-factory-linux-x86_64.AppImage"},
}
PREREQUISITES = {
    "windows": ["Windows 10 or 11 on x64.",
                "Microsoft Edge WebView2 (included in Windows 11; the installer adds it when missing).",
                "Speech and model runtime setup inside the app before fresh production."],
    "linux": ["Linux on x64 with glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 or later).",
              "A desktop session (X11 or Wayland) with OpenGL/EGL, NSS and the usual X libraries.",
              "A Secret Service key store (GNOME Keyring or KWallet) to save API keys.",
              "Speech and model runtime setup inside the app before fresh production."],
}


def host_target() -> str:
    target = {"win32": "windows"}.get(sys.platform, "linux" if sys.platform.startswith("linux") else None)
    if target is None:
        raise SystemExit("Build the Windows app on Windows and the Linux app on Linux; the Mac app uses "
                         "scripts/build-mac-app.sh.")
    if platform.machine().lower() not in ("amd64", "x86_64"):
        raise SystemExit(f"Build on x64; this machine is {platform.machine()}.")
    return target


def run(*command, cwd: Path = ROOT, env: dict | None = None) -> None:
    print("$", subprocess.list2cmdline([str(part) for part in command]), flush=True)
    subprocess.run([str(part) for part in command], cwd=cwd, env=env, check=True)


def download(url: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(Request(url, headers={"User-Agent": "growth-factory-build"}), timeout=300) as response:
        destination.write_bytes(response.read())
    return destination


def app_version() -> str:
    match = re.search(r'__version__\s*=\s*"([^"]+)"', (ROOT / "clip_factory/__init__.py").read_text())
    if not match:
        raise RuntimeError("clip_factory.__version__ not found.")
    return match[1]


def packaging_python(target: str) -> Path:
    venv = Path(os.environ.get("GF_PACKAGE_VENV") or ROOT / "build/packaging-venv")
    python = venv / ("Scripts/python.exe" if target == "windows" else "bin/python")
    if not python.exists():
        run(sys.executable, "-m", "venv", venv)
    extras = ["pywebview[qt]>=5,<7"] if target == "linux" else []
    run(python, "-m", "pip", "install", "--disable-pip-version-check", ".[desktop,test]", *extras,
        "pyinstaller>=6.12,<7", "pyinstaller-hooks-contrib", "setuptools>=75", "wheel")
    return python


def check_inputs() -> None:
    required = ["frontend/dist/index.html", "clip_factory/inference_worker.py", "clip_factory/demo_ui/index.html",
                "clip_factory/fonts/LiberationSans-Regular.ttf", "clip_factory/cloud_config.json",
                "packaging/growth-factory.spec", "packaging/icons/growth-factory.png",
                "packaging/icons/growth-factory.ico"]
    missing = [name for name in required if not (ROOT / name).is_file()]
    if not any((ROOT / "clip_factory/face_models").glob("*")):
        missing.append("clip_factory/face_models/*")
    if missing:
        raise SystemExit(f"Build inputs missing: {', '.join(missing)}")


def webview2_bootstrapper() -> Path:
    """Microsoft's Evergreen bootstrapper, redistributable with apps; its signature is checked."""
    setup = download(WEBVIEW2_BOOTSTRAPPER, ROOT / "build/webview2/MicrosoftEdgeWebview2Setup.exe")
    signer = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"$s = Get-AuthenticodeSignature -LiteralPath '{setup}'; \"$($s.Status)|$($s.SignerCertificate.Subject)\""],
        capture_output=True, text=True, check=True).stdout.strip()
    status, _, subject = signer.partition("|")
    if status != "Valid" or "O=Microsoft Corporation" not in subject:
        raise RuntimeError(f"WebView2 bootstrapper signature is not a valid Microsoft signature: {signer}")
    return setup


def package_windows(bundle: Path) -> Path:
    iscc = shutil.which("iscc") or (str(INNO_DEFAULT) if INNO_DEFAULT.is_file() else None)
    if not iscc:
        raise SystemExit("Inno Setup 6 is required (for example `choco install innosetup`).")
    run(iscc, f"/DAppVersion={app_version()}", f"/DBundleDir={bundle}", f"/DWebView2Setup={webview2_bootstrapper()}",
        f"/DOutputDir={ROOT / 'dist'}", ROOT / "packaging/windows/growth-factory.iss")
    return ROOT / "dist" / TARGETS["windows"]["artifact"]


def package_linux(bundle: Path) -> Path:
    appdir = ROOT / "build/AppDir"
    if appdir.exists():
        shutil.rmtree(appdir)
    shutil.copytree(bundle, appdir / "usr/lib/growth-factory", symlinks=True)
    shutil.copy(ROOT / "packaging/linux/AppRun", appdir / "AppRun")
    (appdir / "AppRun").chmod(0o755)
    shutil.copy(ROOT / "packaging/linux/growth-factory.desktop", appdir / "growth-factory.desktop")
    shutil.copy(ROOT / "packaging/icons/growth-factory.png", appdir / "growth-factory.png")
    icons = appdir / "usr/share/icons/hicolor/256x256/apps"
    icons.mkdir(parents=True)
    shutil.copy(ROOT / "packaging/icons/growth-factory.png", icons / "growth-factory.png")
    (appdir / ".DirIcon").symlink_to("growth-factory.png")
    tool = ROOT / "build/tools/appimagetool-x86_64.AppImage"
    if not tool.is_file():
        download(APPIMAGETOOL, tool)
    tool.chmod(0o755)
    artifact = ROOT / "dist" / TARGETS["linux"]["artifact"]
    # Extract-and-run: CI runners and containers often lack FUSE.
    run(tool, "--no-appstream", appdir, artifact,
        env={**os.environ, "ARCH": "x86_64", "APPIMAGE_EXTRACT_AND_RUN": "1"})
    return artifact


def unpack_appimage(artifact: Path) -> Path:
    """Unpack the built AppImage and return its AppRun, to smoke what actually shipped.

    The runtime's extract-and-run mode (for machines without FUSE) does not pass SIGTERM on to the
    app, so a smoke run through it cannot stop cleanly; a normal FUSE launch hands over to AppRun.
    """
    unpacked = ROOT / "build/appimage-smoke"
    if unpacked.exists():
        shutil.rmtree(unpacked)
    unpacked.mkdir(parents=True)
    run(artifact, "--appimage-extract", cwd=unpacked)
    return unpacked / "squashfs-root/AppRun"


def git_value(*args: str) -> str | None:
    result = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def write_manifest(target: str, artifact: Path, ffmpeg_dir: Path) -> Path:
    notice = (ffmpeg_dir / "FFMPEG-SOURCE.txt").read_text()
    asset = re.search(r"Build: (\S+) \(SHA-256 ([0-9a-f]{64})\)", notice)
    record = {
        "artifact": artifact.name, "platform": {"windows": "Windows", "linux": "Linux"}[target],
        "architecture": "x64", "version": app_version(), "bytes": artifact.stat().st_size,
        "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "built_at": datetime.now(UTC).isoformat(), "git_commit": git_value("rev-parse", "HEAD"),
        "contains_uncommitted_changes": bool(git_value("status", "--porcelain")),
        "signing": "unsigned", "headless_bootstrap_and_demo_assets": "verified",
        "bundled_ffmpeg": {"asset": asset[1], "sha256": asset[2]} if asset else None,
        "release_published": False, "download_url": None,
        "separate_prerequisites": PREREQUISITES[target],
        "limitations": ["Unsigned beta artifact: " + ("Windows SmartScreen warns before the first run."
                                                       if target == "windows" else
                                                       "mark it executable before the first run."),
                        "No clean-machine installation or model-runtime acceptance is implied."],
    }
    destination = artifact.with_name(artifact.name + ".manifest.json")
    destination.write_text(json.dumps(record, indent=2) + "\n")
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--skip-tests", action="store_true", help="skip the bounded packaging tests")
    parser.add_argument("--skip-frontend", action="store_true", help="reuse an existing frontend/dist")
    args = parser.parse_args()
    target = host_target()
    names = TARGETS[target]
    python = packaging_python(target)
    if not args.skip_frontend:
        npm = shutil.which("npm") or sys.exit("Node.js 22.12+ with npm is required to build the frontend.")
        run(npm, "ci", cwd=ROOT / "frontend")
        run(npm, "run", "build", cwd=ROOT / "frontend")
    check_inputs()
    if not args.skip_tests:
        # Bounded checks; the normal development test pass owns the broader suite.
        run(python, "-m", "pytest", "-q", "scripts/tests/test_packaging.py", "scripts/tests/test_desktop_packaging.py",
            "tests/test_demo_loop.py")
    ffmpeg_dir = ROOT / "build/ffmpeg" / target
    run(python, ROOT / "scripts/fetch-ffmpeg.py", "--target", target, "--dest", ffmpeg_dir,
        "--cache", ROOT / "build/ffmpeg-cache")
    # Freeze source assets directly; never erase clip_factory/ui or other tracked source material.
    run(python, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", ROOT / "dist",
        "--workpath", ROOT / "build/pyinstaller" / target, ROOT / "packaging/growth-factory.spec",
        env={**os.environ, "GF_ROOT": str(ROOT), "GF_TARGET": target, "GF_FFMPEG_DIR": str(ffmpeg_dir)})
    bundle = ROOT / "dist" / names["bundle"]
    run(python, ROOT / "scripts/verify-bundle-assets.py", bundle, "--desktop")
    # The bundled FFmpeg is searched before PATH (media.tool_dirs), and the asset check ran it above.
    run(python, ROOT / "scripts/smoke-headless.py", "--executable", bundle / names["cli"], "--expect-ffmpeg")
    artifact = package_windows(bundle) if target == "windows" else package_linux(bundle)
    if target == "linux":
        run(python, ROOT / "scripts/smoke-headless.py", "--executable", unpack_appimage(artifact), "--expect-ffmpeg")
    manifest = write_manifest(target, artifact, ffmpeg_dir)
    print(f"Built {artifact.relative_to(ROOT)} ({artifact.stat().st_size // 1_000_000} MB) and "
          f"{manifest.relative_to(ROOT)}. Unsigned; not uploaded or published.")


if __name__ == "__main__":
    main()
