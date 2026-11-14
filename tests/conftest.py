import pytest


@pytest.fixture(autouse=True)
def no_local_ollama(monkeypatch):
    """Keep tests hermetic even when the developer has Ollama running on 11434."""
    monkeypatch.setenv("OLLAMA_HOST", "127.0.0.1:9")


def board(video_id="source", duration=2.0, *, scenes=2, vision=True, **overrides) -> dict:
    """A deterministic storyboard of equal scenes; stands in for FFmpeg signals and the vision model."""
    span = duration / scenes
    return {
        "id": video_id,
        "video_id": video_id,
        "version": 1,
        "model_id": "qwen-small" if vision else None,
        "vision": vision,
        "created_at": "2026-11-14T00:00:00+00:00",
        "elapsed_seconds": 0.1,
        "duration": duration,
        "transcript_stamp": None,
        "signals": {"interval": 1.0, "method": "keyframes", "motion": [0.5], "loudness": []},
        "scenes": [
            {
                "index": index,
                "start": round(index * span, 3),
                "end": round((index + 1) * span, 3),
                "peak_time": round((index + 0.5) * span, 3),
                "cuts": 0,
                "speech": "",
                "frames": [],
                "visual": f"Visible source scene {index}" if vision else None,
                "action": "low",
                "on_screen_text": [],
                "usable": True,
                "said": "",
                "highlight": 5 if vision else None,
                "highlight_reason": "Scripted",
                "motion": 0.5,
                "loudness": None,
                "score": 0.5,
            }
            for index in range(scenes)
        ],
        "limitations": "Scripted storyboard",
        **overrides,
    }


@pytest.fixture
def watched(monkeypatch):
    """Give an app client a scripted storyboard so tests need neither FFmpeg nor a vision model."""

    def install(client, **options):
        boards = client.app.state.storyboards
        made = []

        def ensure(job, video, model, progress=(5, 95)):
            made.append((video["id"], model))
            return board(video["id"], video["duration"], **options)

        monkeypatch.setattr(boards, "ensure", ensure)
        return made

    return install
