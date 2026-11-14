import pytest


@pytest.fixture(autouse=True)
def no_local_ollama(monkeypatch):
    """Keep tests hermetic even when the developer has Ollama running on 11434."""
    monkeypatch.setenv("OLLAMA_HOST", "127.0.0.1:9")
