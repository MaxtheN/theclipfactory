"""File removal that also works for the read-only files the library keeps.

Saved versions and exports are marked read-only (0o444) so they are not changed by accident. On
Windows that sets the read-only attribute, which also blocks deletion; clear it and retry there.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
from pathlib import Path


def remove_file(path: Path, *, missing_ok: bool = True) -> None:
    try:
        path.unlink(missing_ok=missing_ok)
    except PermissionError:
        if os.name != "nt":
            raise
        path.chmod(stat.S_IREAD | stat.S_IWRITE)
        path.unlink(missing_ok=missing_ok)


def _clear_read_only_and_retry(function, target, error) -> None:
    if os.name != "nt":
        raise error[1] if isinstance(error, tuple) else error  # onerror passes exc_info, onexc the exception
    os.chmod(target, stat.S_IREAD | stat.S_IWRITE)
    function(target)


def remove_tree(path: Path) -> None:
    """Remove a directory tree, read-only files included; a missing tree is fine. Never raises."""
    if not path.exists():
        return
    try:
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=_clear_read_only_and_retry)
        else:
            shutil.rmtree(path, onerror=_clear_read_only_and_retry)
    except OSError:
        shutil.rmtree(path, ignore_errors=True)
