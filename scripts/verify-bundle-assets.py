"""Check frozen runtime data before archiving; does not run native GUI or inference."""
import argparse
import subprocess
from pathlib import Path


def verify(bundle: Path, root: Path, *, desktop: bool = False) -> None:
    """`desktop` is the Windows and Linux bundle: it also carries the face models and FFmpeg."""
    worker = root / "clip_factory/inference_worker.py"
    ui = root / "frontend/dist"
    demo = root / "clip_factory/demo_ui"
    fonts = root / "clip_factory/fonts"
    faces = root / "clip_factory/face_models"
    cloud = root / "clip_factory/cloud_config.json"
    if (not worker.is_file() or not cloud.is_file() or not (ui / "index.html").is_file()
        or any(not (demo / name).is_file() for name in ("index.html", "app.js", "styles.css"))
        or not any(fonts.glob("*.ttf")) or (desktop and not any(faces.iterdir() if faces.is_dir() else ()))):
        raise RuntimeError("Build inputs missing: worker, cloud configuration, built frontend, demo viewer and caption fonts are required.")
    trees = (("ui", ui), ("demo_ui", demo), ("fonts", fonts), *((("face_models", faces),) if desktop else ()))
    # PyInstaller onedir layouts vary; macOS uses Resources/Frameworks with symlinks.
    candidates = list(bundle.rglob("clip_factory/inference_worker.py"))
    for candidate in candidates:
        if candidate.read_bytes() != worker.read_bytes():
            continue
        packaged_cloud = candidate.parent / "cloud_config.json"
        if not packaged_cloud.is_file() or packaged_cloud.read_bytes() != cloud.read_bytes():
            continue
        if all((candidate.parent / name / source.relative_to(tree)).is_file()
               and (candidate.parent / name / source.relative_to(tree)).read_bytes() == source.read_bytes()
               for name, tree in trees
               for source in tree.rglob("*") if source.is_file()):
            if desktop:
                verify_ffmpeg(candidate.parent.parent / "bin")
                print("Packaged worker, frontend, cloud configuration, demo viewer, caption fonts, face models "
                      "and FFmpeg verified (not native acceptance).")
            else:
                print("Packaged worker, frontend, cloud configuration, demo viewer and caption fonts verified (not native acceptance).")
            return
    raise RuntimeError("Bundle is missing or has stale worker/frontend/cloud/demo/font assets.")


def verify_ffmpeg(bin_dir: Path) -> None:
    """FFmpeg sits where media.bundled_tool_dirs() looks, with its licence, and can burn captions."""
    tools = {name: next((p for p in (bin_dir / name, bin_dir / f"{name}.exe") if p.is_file()), None)
             for name in ("ffmpeg", "ffprobe")}
    if not all(tools.values()) or not (bin_dir / "FFMPEG-LICENSE.txt").is_file() \
            or not (bin_dir / "FFMPEG-SOURCE.txt").is_file():
        raise RuntimeError("Bundle is missing FFmpeg, ffprobe or the FFmpeg licence and source notice in bin/.")
    try:
        filters = subprocess.run([str(tools["ffmpeg"]), "-hide_banner", "-filters"], capture_output=True,
                                 text=True, timeout=60, check=True).stdout
        subprocess.run([str(tools["ffprobe"]), "-hide_banner", "-version"], capture_output=True, timeout=60,
                       check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"Bundled FFmpeg does not run: {exc}") from None
    if " subtitles " not in filters or " ass " not in filters:
        raise RuntimeError("Bundled FFmpeg cannot burn captions (no libass).")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--desktop", action="store_true",
                        help="Windows or Linux bundle: also require the face models and a captioning FFmpeg")
    args = parser.parse_args()
    verify(args.bundle, args.root, desktop=args.desktop)


if __name__ == "__main__":
    main()
