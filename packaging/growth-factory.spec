# PyInstaller spec for the Windows and Linux desktop builds. Run it through
# scripts/build-desktop-app.py, which sets the inputs below; the Mac app keeps scripts/build-mac-app.sh.
#
# GF_ROOT        repository root
# GF_TARGET      "windows" or "linux"
# GF_FFMPEG_DIR  folder holding ffmpeg/ffprobe (with libass) and their licence, from scripts/fetch-ffmpeg.py
#
# The bundle is one folder. Windows gets two executables over the same files: "Growth Factory.exe"
# (windowed, what the installer's shortcuts open) and "growth-factory-cli.exe" (console, for
# --headless, --browser and diagnostics, since a windowed program has no stdout).
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata

ROOT = Path(os.environ["GF_ROOT"]).resolve()
TARGET = os.environ["GF_TARGET"]
FFMPEG = Path(os.environ["GF_FFMPEG_DIR"]).resolve()
if TARGET not in ("windows", "linux"):
    raise SystemExit(f"GF_TARGET must be windows or linux, not {TARGET!r}")
SUFFIX = ".exe" if TARGET == "windows" else ""

datas = [
    (str(ROOT / "frontend/dist"), "clip_factory/ui"),
    (str(ROOT / "clip_factory/demo_ui"), "clip_factory/demo_ui"),
    (str(ROOT / "clip_factory/fonts"), "clip_factory/fonts"),
    (str(ROOT / "clip_factory/face_models"), "clip_factory/face_models"),
    (str(ROOT / "clip_factory/inference_worker.py"), "clip_factory"),
    (str(ROOT / "clip_factory/cloud_config.json"), "clip_factory"),
    # media.bundled_tool_dirs() looks in <bundle>/bin; the licence and source notice travel with them.
    *[(str(path), "bin") for path in sorted(FFMPEG.iterdir()) if path.is_file() and path.suffix != SUFFIX],
]
binaries = [(str(FFMPEG / f"{name}{SUFFIX}"), "bin") for name in ("ffmpeg", "ffprobe")]
hiddenimports = [
    "clip_factory.app", "clip_factory.main",
    *collect_submodules("clip_factory"), *collect_submodules("platformdirs"),
]
datas += copy_metadata("keyring")
# Face detection off the Mac (faces.py) and the window, key store and server packages ship whole:
# their plugins and data files are found at run time, which PyInstaller's import scan misses.
# OpenCV (cv2) is left to pyinstaller-hooks-contrib, whose hook handles its loader configuration.
packages = ["webview", "keyring", "uvicorn", "mediapipe"]
packages += ["win32ctypes"] if TARGET == "windows" else ["secretstorage", "jeepney"]
for package in packages:
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden
# Linux windows open through pywebview's Qt backend (PyQt6 WebEngine, bundled by PyInstaller's own
# hooks), so the app does not depend on the system's WebKitGTK version.
if TARGET == "linux":
    # Only the Qt modules the backend imports; collecting all of qtpy would pull in every PyQt6 module.
    hiddenimports += ["webview.platforms.qt", "qtpy", "PyQt6.QtWebEngineWidgets", "PyQt6.QtWebEngineCore",
                      "PyQt6.QtWebChannel", "PyQt6.QtNetwork"]
# The Mac-only framework bindings and the GTK backend are never used here.
excludes = ["AppKit", "Foundation", "WebKit", "Vision", "CoreML", "Quartz", "objc", "gi",
            "webview.platforms.cocoa", "webview.platforms.gtk", "tkinter"]
if TARGET == "linux":
    excludes += ["webview.platforms.edgechromium", "webview.platforms.winforms", "clr"]

analysis = Analysis(
    [str(ROOT / "scripts/desktop-entry.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(analysis.pure)
icon = str(ROOT / "packaging/icons" / ("growth-factory.ico" if TARGET == "windows" else "growth-factory.png"))
executables = [
    EXE(
        pyz, analysis.scripts, [],
        exclude_binaries=True,
        name="Growth Factory" if TARGET == "windows" else "growth-factory",
        console=TARGET == "linux",  # Linux has no console window to hide; keep stdout for diagnostics.
        icon=icon,
        upx=False,
    )
]
if TARGET == "windows":
    executables.append(
        EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="growth-factory-cli", console=True,
            icon=icon, upx=False)
    )
COLLECT(*executables, analysis.binaries, analysis.datas, upx=False,
        name="Growth Factory" if TARGET == "windows" else "growth-factory")
