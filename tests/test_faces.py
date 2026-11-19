"""Face detection on every platform: backend selection, real detections on fixtures, fallbacks."""

import sys
from pathlib import Path

import pytest

from clip_factory import craft, faces, reframe

FIXTURES = Path(__file__).parent / "fixtures" / "faces"
# Public-domain NASA photos (Wikimedia Commons), resized to the reframe sample width (640 px).
CREW = FIXTURES / "apollo_11_crew.jpg"     # Apollo 11 crew, 1969: three faces, landscape
RIDE = FIXTURES / "sally_ride.jpg"         # Sally Ride, 1984: one face, portrait
OFF_MAC = sys.platform != "darwin"


@pytest.fixture(autouse=True)
def fresh_status():
    faces._status = None
    yield
    faces._status = None


def opencv_backend():
    pytest.importorskip("cv2")
    pytest.importorskip("mediapipe")
    if not OFF_MAC:
        pytest.skip("macOS uses Apple Vision; the OpenCV backend is for Windows and Linux")
    state = faces.status()
    assert state["backend"] == faces.OPENCV and state["ready"], state
    return state


# --------------------------------------------------------------------------------- selection


def test_macos_selects_apple_vision_or_says_why_not(monkeypatch):
    monkeypatch.setattr(faces.sys, "platform", "darwin")
    monkeypatch.setitem(sys.modules, "Vision", None)  # import fails, as on a Mac without pyobjc
    state = faces.status(refresh=True)
    assert state["backend"] is None and state["ready"] is False
    assert state["reason"].startswith("Apple Vision is not available")
    assert reframe.available() == (False, state["reason"])


@pytest.mark.parametrize("system", ["win32", "linux"])
def test_windows_and_linux_select_opencv_or_say_why_not(monkeypatch, system):
    monkeypatch.setattr(faces.sys, "platform", system)
    monkeypatch.setitem(sys.modules, "cv2", None)
    state = faces.status(refresh=True)
    assert state == {"backend": None, "label": None, "ready": False, "mouth": False, "mouth_reason": None,
                     "reason": state["reason"]}
    assert state["reason"].startswith("OpenCV is not installed")
    with pytest.raises(RuntimeError, match="OpenCV is not installed"):
        faces.detect(b"")


def test_a_damaged_model_file_is_refused(monkeypatch, tmp_path):
    pytest.importorskip("cv2")
    monkeypatch.setattr(faces.sys, "platform", "linux")
    (tmp_path / faces.YUNET[0]).write_bytes(b"not the model")
    monkeypatch.setattr(faces, "MODELS", tmp_path)
    state = faces.status(refresh=True)
    assert state["ready"] is False and "does not match its checksum" in state["reason"]
    (tmp_path / faces.YUNET[0]).unlink()
    assert "is missing from the app" in faces.status(refresh=True)["reason"]


def test_bundled_models_match_their_pinned_checksums():
    for spec in (faces.YUNET, faces.LANDMARKER):
        assert faces._model(spec).stat().st_size > 100_000


def test_without_mediapipe_faces_are_still_found_with_no_mouth(monkeypatch):
    pytest.importorskip("cv2")
    monkeypatch.setattr(faces.sys, "platform", "linux")

    def no_egl():
        raise OSError("libEGL.so.1: cannot open shared object file")

    monkeypatch.setattr(faces, "_load_landmarker", no_egl)
    monkeypatch.setattr(faces, "_landmarker", None)  # not the one an earlier test loaded
    state = faces.status(refresh=True)
    assert state["backend"] == faces.OPENCV and state["ready"] and state["mouth"] is False
    assert "libEGL.so.1" in state["mouth_reason"]
    found = faces.detect(CREW.read_bytes())["faces"]
    assert len(found) == 3 and all(face["mouth"] is None for face in found)


# ------------------------------------------------------------------------- real detections


def test_three_faces_in_a_landscape_group_shot():
    state = opencv_backend()
    found = faces.detect(CREW.read_bytes())
    assert found["people"] == []
    centres = sorted(round(face["x"], 3) for face in found["faces"])
    assert centres == pytest.approx([0.251, 0.484, 0.725], abs=0.02)
    for face in found["faces"]:
        assert face["w"] == pytest.approx(0.08, abs=0.02) and face["h"] == pytest.approx(0.135, abs=0.025)
        if state["mouth"]:
            # Inner-lip opening / face height: the unit Apple Vision's face-box-normalised lips give.
            assert 0.0 <= face["mouth"] < 0.2


def test_one_face_in_a_portrait_with_top_left_boxes():
    opencv_backend()
    boxes = craft.face_rectangles(RIDE.read_bytes())
    assert len(boxes) == 1
    box = boxes[0]
    assert box["x"] == pytest.approx(0.389, abs=0.02) and box["y"] == pytest.approx(0.228, abs=0.02)
    assert box["w"] == pytest.approx(0.262, abs=0.02) and box["h"] == pytest.approx(0.244, abs=0.02)
    face = reframe.detect(RIDE.read_bytes())["faces"][0]
    assert face["x"] == pytest.approx(box["x"] + box["w"] / 2, abs=1e-6)


def test_mouth_is_measured_on_every_face_when_landmarks_load():
    state = opencv_backend()
    if not state["mouth"]:
        pytest.fail(f"MediaPipe landmarks did not load: {state['mouth_reason']}")
    mouths = [face["mouth"] for face in faces.detect(CREW.read_bytes())["faces"]]
    assert all(m is not None for m in mouths)
    assert faces.detect(RIDE.read_bytes())["faces"][0]["mouth"] == pytest.approx(0.06, abs=0.03)


def test_no_face_means_no_faces_and_an_unreadable_frame_is_an_error():
    opencv_backend()
    import cv2
    import numpy as np

    blank = np.full((360, 640, 3), 90, dtype=np.uint8)
    _, jpeg = cv2.imencode(".jpg", blank)
    found = faces.detect(jpeg.tobytes())
    assert found == {"faces": [], "people": []}
    assert faces.rectangles(jpeg.tobytes()) == []
    with pytest.raises(ValueError, match="could not be decoded"):
        faces.detect(b"not a jpeg")


# --------------------------------------------------------------------------------- fallback


def test_reframe_keeps_the_centre_crop_and_says_why_without_a_detector(monkeypatch, tmp_path):
    monkeypatch.setattr(faces.sys, "platform", "linux")
    monkeypatch.setitem(sys.modules, "cv2", None)
    planned = reframe.plan("ffmpeg", tmp_path / "x.mp4", [{"start": 0, "span": 5}], width=1920, height=1080)
    assert planned["status"] == "unavailable"
    assert planned["summary"]["detector"] is None
    assert planned["summary"]["reason"].startswith("OpenCV is not installed")


def test_reframe_records_the_backend_and_a_missing_mouth_signal(monkeypatch, tmp_path):
    monkeypatch.setattr(faces, "status", lambda **_: {"backend": faces.OPENCV, "ready": True, "reason": None,
                                                     "mouth": False, "mouth_reason": "Mouth movement is unavailable."})
    monkeypatch.setattr(faces, "available", lambda: (True, None))
    monkeypatch.setattr(reframe, "sample", lambda *a, **k: ([], []))
    planned = reframe.plan("ffmpeg", tmp_path / "x.mp4", [{"start": 0, "span": 5}], width=1920, height=1080)
    assert planned["summary"]["detector"] == faces.OPENCV
    assert planned["summary"]["mouth"] == "Mouth movement is unavailable."
    assert planned["status"] == "fallback"  # no samples, so too few faces: the fixed crop stays


def test_caption_placement_falls_back_without_a_detector(monkeypatch, tmp_path):
    monkeypatch.setattr(faces.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "cv2", None)
    boxes, state = craft.hook_face_boxes("ffmpeg", tmp_path / "x.mp4", 0, 2, width=1080, height=1920,
                                         framing="fill", crop_x=0.5)
    assert boxes == [] and state.startswith("unavailable: OpenCV is not installed")


def test_face_follow_applies_end_to_end_on_a_landscape_video(tmp_path):
    opencv_backend()
    import shutil
    import subprocess

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("FFmpeg is not installed")
    video = tmp_path / "crew.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", str(CREW),
                    "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
                    "-t", "4", "-r", "30", "-pix_fmt", "yuv420p", str(video)], check=True)
    planned = reframe.plan(ffmpeg, video, [{"start": 0, "span": 4}], width=1280, height=720)
    assert planned["status"] == "applied", planned["summary"]
    assert planned["summary"]["detector"] == faces.OPENCV and planned["summary"]["face_share"] == 1.0
    assert len(planned["filters"]) == 1
