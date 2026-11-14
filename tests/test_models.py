"""Truthful inference prerequisites, without model downloads or runtime installation."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from clip_factory.jobs import WorkError
from clip_factory.models import CATALOG, Models


@pytest.fixture
def models(tmp_path):
    jobs = Mock()
    jobs.process.side_effect = AssertionError("Must not start inference or installation")
    return Models(tmp_path, jobs)


def installed(models, identifier):
    directory = models.model_dir / identifier
    directory.mkdir()
    (directory / ".complete").write_text("{}")


def runtime_ready(models):
    models.python.parent.mkdir(parents=True)
    models.python.touch()
    (models.runtime / ".ready").touch()


def test_catalog_does_not_invent_installations(models):
    assert len(models.catalog()) == len(CATALOG)
    assert all(not row["installed"] for row in models.catalog())
    assert not models.ready()
    installed(models, "qwen-small")
    assert models.item("qwen-small")["installed"]
    assert not models.ready()
    with pytest.raises(WorkError, match="Unknown"):
        models.item("../../escape")


@pytest.mark.parametrize("identifier,kind", [("qwen-small", "llm"), ("whisper-turbo", "asr"), ("kokoro", "tts")])
def test_require_missing_weights_has_no_simulation(models, identifier, kind):
    with pytest.raises(WorkError, match="Download and accept"):
        models.require(identifier, kind)
    models.jobs.process.assert_not_called()


def test_require_installed_weights_still_needs_runtime(models):
    installed(models, "qwen-small")
    with pytest.raises(WorkError, match="runtime"):
        models.require("qwen-small", "llm")
    with pytest.raises(WorkError, match="appropriate"):
        models.require("qwen-small", "asr")
    models.jobs.process.assert_not_called()


def test_ready_requires_both_markers(models):
    models.python.parent.mkdir(parents=True)
    models.python.touch()
    assert not models.ready()
    (models.runtime / ".ready").touch()
    assert models.ready()
    models.python.unlink()
    assert not models.ready()


def test_require_platform_and_available_memory(models, monkeypatch):
    installed(models, "qwen-small")
    runtime_ready(models)
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: False)
    with pytest.raises(WorkError, match="Apple Silicon"):
        models.require("qwen-small", "llm")
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr("clip_factory.models.psutil.virtual_memory", lambda: SimpleNamespace(available=1))
    with pytest.raises(WorkError, match="memory"):
        models.require("qwen-small", "llm")
    monkeypatch.setattr("clip_factory.models.psutil.virtual_memory", lambda: SimpleNamespace(available=100 * 10**9))
    assert models.require("qwen-small", "llm") is None
    models.jobs.process.assert_not_called()


def test_run_without_runtime_never_fabricates_result(models):
    installed(models, "qwen-small")
    with pytest.raises(WorkError, match="runtime"):
        models.run("job", "qwen-small", "generate", prompt="Write a hook")
    assert not (models.root / "work").exists()
    models.jobs.process.assert_not_called()


def test_non_apple_setup_never_runs_installation(models, monkeypatch):
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: False)
    with pytest.raises(WorkError, match="Manual editing works"):
        models.setup("job")
    models.jobs.process.assert_not_called()
