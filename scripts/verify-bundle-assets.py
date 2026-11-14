"""Check frozen runtime data before archiving; does not run native GUI or inference."""
import argparse
from pathlib import Path


def verify(bundle: Path, root: Path) -> None:
    worker = root / "clip_factory/inference_worker.py"
    ui = root / "frontend/dist"
    if not worker.is_file() or not (ui / "index.html").is_file():
        raise RuntimeError("Build inputs missing: standalone worker and built frontend are required.")
    # PyInstaller onedir layouts vary; macOS uses Resources/Frameworks with symlinks.
    candidates = list(bundle.rglob("clip_factory/inference_worker.py"))
    for candidate in candidates:
        packaged_ui = candidate.parent / "ui"
        if candidate.read_bytes() != worker.read_bytes():
            continue
        if all((packaged_ui / source.relative_to(ui)).is_file()
               and (packaged_ui / source.relative_to(ui)).read_bytes() == source.read_bytes()
               for source in ui.rglob("*") if source.is_file()):
            print("Packaged standalone worker and built UI assets verified (not native acceptance).")
            return
    raise RuntimeError("Bundle is missing or has stale standalone worker/UI assets.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    verify(args.bundle, args.root)


if __name__ == "__main__":
    main()
