"""Renderer extensions: merged, reviewed modules that add a craft capability.

The registry loads extension modules only from this package's own directory, and inside a Git
checkout only the ones committed at HEAD with no local edits: code from a Factory builder branch
or worktree (under the app data dir) is never imported by the running app. Every module passes
the same static allowlist the builder enforces before its tests ever run, and its interface is
checked on load. A broken module is skipped and reported, never half-loaded.
"""

from __future__ import annotations

import ast
import importlib.util
import re
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

from .base import (
    ExtensionError,
    Fragment,
    Geometry,
    Timing,
    ass_document,
    check_fragment,
    check_schema,
    validate_params,
)

PACKAGE_DIR = Path(__file__).resolve().parent
RESERVED = {"__init__", "base"}
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,40}$")
MAX_SOURCE_BYTES = 24_000
MAX_SOURCE_LINES = 400
MAX_TEST_BYTES = 24_000

# Generated code may import only these.
ALLOWED_IMPORTS = {"__future__", "math", "re", "dataclasses", "typing", "clip_factory.extensions.base"}
TEST_EXTRA_IMPORTS = {"pytest"}
FORBIDDEN_NAMES = {
    "exec", "eval", "compile", "open", "__import__", "globals", "locals", "vars", "getattr", "setattr",
    "delattr", "input", "breakpoint", "memoryview", "os", "sys", "subprocess", "socket", "builtins",
    "importlib", "shutil", "pathlib", "Path", "ctypes", "pickle", "marshal", "signal", "threading",
    "multiprocessing", "asyncio", "urllib", "http", "requests", "httpx", "exit", "quit", "help",
    "__builtins__", "__loader__", "__spec__",
}


def static_check(source: str, *, capability: str | None = None, test: bool = False) -> list[str]:
    """AST allowlist for generated extension (or test) code. Empty list = acceptable."""
    problems: list[str] = []
    limit = MAX_TEST_BYTES if test else MAX_SOURCE_BYTES
    if len(source.encode("utf-8")) > limit:
        problems.append(f"File is larger than {limit} bytes.")
    if source.count("\n") > MAX_SOURCE_LINES * (2 if test else 1):
        problems.append("File has too many lines.")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"Syntax error on line {exc.lineno}: {exc.msg}"]
    allowed = set(ALLOWED_IMPORTS) | (TEST_EXTRA_IMPORTS if test else set())
    if test and capability:
        allowed.add(f"clip_factory.extensions.{capability}")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in allowed:
                    problems.append(f"Line {node.lineno}: import {alias.name} is not allowed.")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                module = "clip_factory.extensions" + (f".{module}" if module else "")
            if module not in allowed and not (module == "clip_factory.extensions" and test and capability
                                              and all(a.name == capability for a in node.names)):
                problems.append(f"Line {node.lineno}: import from {module or '.'} is not allowed.")
            if any(alias.name == "*" for alias in node.names):
                problems.append(f"Line {node.lineno}: star imports are not allowed.")
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            problems.append(f"Line {node.lineno}: {node.id} is not allowed.")
        elif isinstance(node, ast.Attribute) and (node.attr.startswith("__") or node.attr in FORBIDDEN_NAMES):
            problems.append(f"Line {node.lineno}: attribute {node.attr} is not allowed.")
        elif isinstance(node, (ast.While, ast.AsyncFunctionDef, ast.Await, ast.Global, ast.Nonlocal)):
            problems.append(f"Line {node.lineno}: {type(node).__name__} is not allowed.")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.startswith("__") \
                and node.value.endswith("__"):
            problems.append(f"Line {node.lineno}: dunder strings are not allowed.")
    if not test:
        names = {t.id for n in tree.body if isinstance(n, ast.Assign) for t in n.targets if isinstance(t, ast.Name)}
        names |= {n.target.id for n in tree.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)}
        functions = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
        for required in ("CAPABILITY", "LABEL", "DESCRIPTION", "PARAMS", "PROVENANCE"):
            if required not in names:
                problems.append(f"Module must define {required}.")
        if "build" not in functions:
            problems.append("Module must define build(geometry, timing, params).")
        for node in tree.body:
            if not isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign, ast.FunctionDef,
                                     ast.ClassDef, ast.Expr)):
                problems.append(f"Line {node.lineno}: top-level {type(node).__name__} is not allowed.")
            if isinstance(node, ast.Expr) and not (isinstance(node.value, ast.Constant)
                                                   and isinstance(node.value.value, str)):
                problems.append(f"Line {node.lineno}: top-level expressions other than docstrings are not allowed.")
    return problems


@dataclass(frozen=True)
class Extension:
    capability: str
    label: str
    description: str
    params: dict
    provenance: str
    build: object
    path: str

    def public(self) -> dict:
        return {"capability": self.capability, "label": self.label, "description": self.description,
                "params": self.params, "provenance": self.provenance, "merged": True}

    def render(self, geometry: Geometry, timing: Timing, params: dict | None) -> Fragment:
        checked = validate_params(self.params, params)
        fragment = self.build(geometry, timing, checked)  # type: ignore[operator]
        problems = check_fragment(fragment)
        if problems:
            raise ExtensionError(f"{self.capability}: " + "; ".join(problems)[:600])
        return fragment


def committed_files(directory: Path) -> set[str] | None:
    """Names committed at HEAD and unmodified in this checkout, or None outside a Git checkout."""
    try:
        top = subprocess.run(["git", "-C", str(directory), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=10, check=False)
        if top.returncode:
            return None
        listed = subprocess.run(["git", "-C", str(directory), "ls-tree", "--name-only", "HEAD", "./"],
                                capture_output=True, text=True, timeout=10, check=False)
        dirty = subprocess.run(["git", "-C", str(directory), "status", "--porcelain", "--", "."],
                               capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if listed.returncode:
        return None
    names = {Path(line.strip()).name for line in listed.stdout.splitlines() if line.strip()}
    changed = {Path(line[3:].strip().strip('"')).name for line in dirty.stdout.splitlines() if len(line) > 3}
    return names - changed


class Registry:
    def __init__(self, directory: Path | None = None, *, package: str = "clip_factory.extensions",
                 require_committed: bool = True):
        self.directory = Path(directory or PACKAGE_DIR).resolve()
        self.package = package
        self.require_committed = require_committed
        self.extensions: dict[str, Extension] = {}
        self.errors: dict[str, str] = {}
        self.skipped: dict[str, str] = {}
        self.load()

    def load(self):
        committed = committed_files(self.directory) if self.require_committed else None
        for path in sorted(self.directory.glob("*.py")):
            name = path.stem
            if name in RESERVED or name.startswith(("_", "test_")):
                continue
            if not NAME_PATTERN.match(name):
                self.skipped[name] = "Module name is not a capability name."
                continue
            if committed is not None and path.name not in committed:
                self.skipped[name] = "Not merged: the file is uncommitted or edited in this checkout."
                continue
            try:
                self.extensions[name] = self._load(path)
            except Exception as exc:  # noqa: BLE001 - one bad module never blocks the others
                self.errors[name] = str(exc)[:400] or type(exc).__name__

    def _load(self, path: Path) -> Extension:
        source = path.read_text(encoding="utf-8")
        problems = static_check(source)
        if problems:
            raise ExtensionError("Static check failed: " + "; ".join(problems)[:300])
        module_name = f"{self.package}.{path.stem}"
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ExtensionError("Cannot load module.")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(module_name, None)
            raise
        ns = module.__dict__
        if ns.get("CAPABILITY") != path.stem:
            raise ExtensionError("CAPABILITY must equal the module name.")
        schema_problems = check_schema(ns.get("PARAMS"))
        if schema_problems:
            raise ExtensionError("; ".join(schema_problems)[:300])
        for key in ("LABEL", "DESCRIPTION", "PROVENANCE"):
            if not isinstance(ns.get(key), str) or not ns[key].strip() or len(ns[key]) > 300:
                raise ExtensionError(f"{key} must be a short non-empty string.")
        extension = Extension(path.stem, ns["LABEL"].strip(), ns["DESCRIPTION"].strip(), dict(ns["PARAMS"]),
                              ns["PROVENANCE"].strip(), ns["build"], str(path))
        # Smoke: defaults must produce a valid fragment for a typical clip.
        extension.render(Geometry(), Timing(duration=15.0, hook_seconds=2.0, cuts=(4.0, 9.5)), {})
        return extension

    def public(self) -> dict:
        return {"extensions": [e.public() for e in self.extensions.values()],
                "errors": dict(self.errors), "skipped": dict(self.skipped)}


_registry: Registry | None = None
_lock = threading.Lock()


def registry(*, reload: bool = False) -> Registry:
    """The app's registry, built once per process (a merged extension appears after a restart)."""
    global _registry
    with _lock:
        if _registry is None or reload:
            _registry = Registry()
        return _registry


def validate_selection(selection: dict, reg: Registry | None = None) -> dict:
    """CraftOptions.extensions: {capability: params}; names must be merged extensions."""
    if not selection:
        return {}
    reg = reg or registry()
    out = {}
    for name, params in selection.items():
        extension = reg.extensions.get(name)
        if extension is None:
            raise ExtensionError(f"No merged renderer extension named {str(name)[:40]}.")
        if params is not None and not isinstance(params, dict):
            raise ExtensionError(f"Settings for {name} must be an object.")
        out[name] = validate_params(extension.params, params)
    return out


def apply(selection: dict | None, *, duration: float, hook_seconds: float = 0.0,
          end_card_start: float | None = None, cuts: tuple[float, ...] = (),
          reg: Registry | None = None) -> dict:
    """Filters, one ASS document and provenance for the selected extensions (all off by default)."""
    if not selection:
        return {"filters": [], "ass": None, "applied": []}
    reg = reg or registry()
    geometry = Geometry()
    timing = Timing(duration=float(duration), hook_seconds=float(hook_seconds),
                    end_card_start=end_card_start, cuts=tuple(float(c) for c in cuts))
    filters, fragments, applied = [], [], []
    for name, params in selection.items():
        extension = reg.extensions.get(name)
        if extension is None:
            raise ExtensionError(f"Renderer extension {str(name)[:40]} is not merged in this build.")
        fragment = extension.render(geometry, timing, params)
        filters.extend(fragment.video_filters)
        if fragment.ass_events:
            fragments.append(fragment)
        applied.append({"capability": name, "params": validate_params(extension.params, params),
                        "provenance": extension.provenance, "filters": len(fragment.video_filters),
                        "ass_events": len(fragment.ass_events)})
    return {"filters": filters, "ass": ass_document(fragments, geometry) if fragments else None, "applied": applied}


__all__ = [
    "ALLOWED_IMPORTS", "Extension", "ExtensionError", "Registry", "apply", "registry", "static_check",
    "validate_selection",
]
