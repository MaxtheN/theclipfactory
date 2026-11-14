"""Check frozen runtime data before archiving; does not run native GUI or inference."""
import argparse
from pathlib import Path


def verify(bundle: Path, root: Path) -> None:
    worker = root / "clip_factory/inference_worker.py"
    ui = root / "frontend/dist"
    demo = root / "clip_factory/demo_ui"
    cloud = root / "clip_factory/cloud_config.json"
    if (not worker.is_file() or not cloud.is_file() or not (ui / "index.html").is_file()
        or any(not (demo / name).is_file() for name in ("index.html", "app.js", "styles.css"))):
        raise RuntimeError("Build inputs missing: worker, cloud configuration, built frontend and demo viewer are required.")
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
               for name, tree in (("ui", ui), ("demo_ui", demo)) for source in tree.rglob("*") if source.is_file()):
            print("Packaged worker, frontend, cloud configuration and demo viewer verified (not native acceptance).")
            return
    raise RuntimeError("Bundle is missing or has stale worker/frontend/cloud/demo assets.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    verify(args.bundle, args.root)


if __name__ == "__main__":
    main()
