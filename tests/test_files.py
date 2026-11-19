import os
import stat

import pytest

from clip_factory import files


def test_read_only_files_and_trees_can_be_removed(tmp_path):
    """Saved versions are read-only (0o444); deleting them must work on Windows too."""
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"video")
    clip.chmod(0o444)
    files.remove_file(clip)
    assert not clip.exists()
    files.remove_file(clip)  # missing is fine by default
    with pytest.raises(FileNotFoundError):
        files.remove_file(clip, missing_ok=False)

    folder = tmp_path / "export"
    (folder / "nested").mkdir(parents=True)
    for path in (folder / "video.mp4", folder / "nested" / "captions.srt"):
        path.write_text("x")
        path.chmod(0o444)
    files.remove_tree(folder)
    assert not folder.exists()
    files.remove_tree(folder)


@pytest.mark.skipif(os.name != "nt", reason="only Windows blocks deleting read-only files")
def test_windows_clears_the_read_only_attribute_first(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"video")
    clip.chmod(stat.S_IREAD)
    with pytest.raises(PermissionError):
        clip.unlink()
    files.remove_file(clip)
    assert not clip.exists()
