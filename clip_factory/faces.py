"""Face detection for face-follow crops and caption placement, on every supported computer.

Two backends behind one contract:

* ``apple_vision`` (macOS): Apple Vision on-device through pyobjc. Face landmarks give the
  inner-lip opening; human rectangles stand in when no face is found. No model file.
* ``opencv_yunet`` (Windows and Linux): OpenCV's YuNet face detector
  (``face_detection_yunet_2023mar.onnx``, MIT, 0.23 MB, from opencv_zoo) finds the faces; the
  MediaPipe Face Landmarker (``face_landmarker.task``, float16 v1, Apache-2.0, 3.8 MB) then
  measures the inner-lip opening on each face crop; OpenCV's built-in HOG people detector
  stands in when no face is found. Both model files ship inside the package
  (``clip_factory/face_models``) and are checked against their SHA-256 before first use, so
  nothing downloads at run time. The Python packages (``opencv-contrib-python`` and
  ``mediapipe``, about 270 MB installed) are app dependencies on Windows and Linux only.

Why two models off the Mac: the Face Landmarker's own detector is short-range and found no face
in a three-person landscape shot at the 640 px sample size, while YuNet alone has no lip points.

Mouth opening is measured the same way on both backends: the inner-lip contour's vertical span
divided by the face height (Vision normalises lip points to the face box; here the span is
divided by the landmark mesh height), so the per-face movement signal ``reframe`` uses is
comparable. When MediaPipe cannot load (for example ``libEGL.so.1`` is missing on a minimal
Linux), faces are still found and ``mouth`` is ``None``; ``status()`` says why.

Every output is normalised to [0, 1]. ``detect()`` returns face centres for the reframe path;
``rectangles()`` returns top-left-origin boxes for caption placement.
"""

from __future__ import annotations

import atexit
import hashlib
import os
import sys
import threading
from pathlib import Path

APPLE = "apple_vision"
OPENCV = "opencv_yunet"
LABELS = {APPLE: "Apple Vision", OPENCV: "OpenCV YuNet with MediaPipe face landmarks"}

MODELS = Path(__file__).with_name("face_models")
YUNET = ("face_detection_yunet_2023mar.onnx", "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4")
LANDMARKER = ("face_landmarker.task", "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff")

MIN_CONFIDENCE = 0.5          # Vision's cut, kept on both backends
YUNET_SCORE = 0.7             # YuNet's own score is stricter-scaled; 0.7 keeps small real faces
CROP_SCALE = 1.8              # face crop side for the landmarker, as a multiple of the face box
CROP_SIZE = 256
MAX_FACES = 8
# Inner-lip contour of the MediaPipe face mesh (upper then lower).
INNER_LIPS = (78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 95, 88, 178, 87, 14, 317, 402, 318, 324)

_lock = threading.Lock()
_status: dict | None = None
_yunet = None
_landmarker = None
_hog = None


# --------------------------------------------------------------------------- selection

def status(*, refresh: bool = False) -> dict:
    """Which backend is active on this computer, or why none is. Cached.

    ``{backend: apple_vision|opencv_yunet|None, label, ready, reason, mouth, mouth_reason}``.
    """
    global _status
    with _lock:
        if _status is None or refresh:
            _status = _apple_status() if sys.platform == "darwin" else _opencv_status()
        return dict(_status)


def available() -> tuple[bool, str | None]:
    """(True, None) when a backend is ready, else (False, reason)."""
    state = status()
    return state["ready"], state["reason"]


def backend() -> str | None:
    state = status()
    return state["backend"] if state["ready"] else None


def _state(backend_name, *, ready, reason=None, mouth=False, mouth_reason=None) -> dict:
    return {"backend": backend_name, "label": LABELS.get(backend_name), "ready": ready, "reason": reason,
            "mouth": mouth, "mouth_reason": mouth_reason}


def _short(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {str(exc)[:120]}"


def _apple_status() -> dict:
    try:
        import Foundation  # noqa: F401
        import objc  # noqa: F401
        import Vision  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - ImportError, or a framework load failure
        return _state(None, ready=False, reason=f"Apple Vision is not available ({_short(exc)}).")
    return _state(APPLE, ready=True, mouth=True)


def _model(spec: tuple[str, str]) -> Path:
    """A bundled model file, checked against its pinned SHA-256."""
    name, digest = spec
    path = MODELS / name
    if not path.is_file():
        raise FileNotFoundError(f"{name} is missing from the app")
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError(f"{name} does not match its checksum")
    return path


def _opencv_status() -> dict:
    global _yunet, _landmarker, _hog
    try:
        import cv2
        import numpy  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        return _state(None, ready=False, reason=f"OpenCV is not installed ({_short(exc)}).")
    try:
        _yunet = cv2.FaceDetectorYN.create(str(_model(YUNET)), "", (320, 320), YUNET_SCORE, 0.3, 5000)
        _hog = cv2.HOGDescriptor()
        _hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    except Exception as exc:  # noqa: BLE001
        return _state(None, ready=False, reason=f"The face detector could not load ({_short(exc)}).")
    try:
        _landmarker = _landmarker or _load_landmarker()
    except Exception as exc:  # noqa: BLE001 - faces still work, only mouth movement is lost
        _landmarker = None
        return _state(OPENCV, ready=True, mouth=False,
                      mouth_reason=f"Mouth movement is unavailable: MediaPipe could not load ({_short(exc)}).")
    return _state(OPENCV, ready=True, mouth=True)


def _load_landmarker():
    os.environ.setdefault("GLOG_minloglevel", "2")  # MediaPipe's native logging is noisy on load
    from mediapipe.tasks.python import BaseOptions, vision

    options = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(_model(LANDMARKER))),
        num_faces=1, min_face_detection_confidence=0.3, min_face_presence_confidence=0.3)
    landmarker = vision.FaceLandmarker.create_from_options(options)
    _on_exit(lambda: _close(landmarker))
    return landmarker


def _on_exit(callback) -> None:
    """Run ``callback`` at interpreter exit, before thread pools shut down.

    MediaPipe serialises every native call through its own one-thread executor, and Python shuts
    executors down before ordinary ``atexit`` handlers run, so a landmarker closed there (or by its
    ``__del__``) fails noisily. ``threading._register_atexit`` runs first; ``atexit`` is the fallback.
    """
    register = getattr(threading, "_register_atexit", None)
    try:
        if register is None:
            raise RuntimeError
        register(callback)
    except RuntimeError:
        atexit.register(callback)


def _close(landmarker) -> None:
    try:
        landmarker.close()
    except Exception:  # noqa: BLE001, S110 - interpreter shutdown
        pass


# --------------------------------------------------------------------------- public contract

def detect(jpeg: bytes) -> dict:
    """Faces (and people when no face is found) in one image, normalised to [0, 1].

    Each face: {"x": centre x, "w": width, "h": height, "mouth": inner-lip opening / face height
    or None}. People have the same keys with ``mouth`` None.
    """
    state = status()
    if not state["ready"]:
        raise RuntimeError(state["reason"])
    return _apple_detect(jpeg) if state["backend"] == APPLE else _opencv_detect(jpeg)


def rectangles(jpeg: bytes) -> list[dict]:
    """Face boxes in one image, normalised with a top-left origin: [{x, y, w, h}]."""
    state = status()
    if not state["ready"]:
        raise RuntimeError(state["reason"])
    return _apple_rectangles(jpeg) if state["backend"] == APPLE else _opencv_rectangles(jpeg)


# --------------------------------------------------------------------------- Apple Vision

def _apple_detect(jpeg: bytes) -> dict:
    import Foundation
    import objc
    import Vision

    faces: list[dict] = []
    people: list[dict] = []
    with objc.autorelease_pool():
        data = Foundation.NSData.dataWithBytes_length_(jpeg, len(jpeg))
        handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, {})
        face_request = Vision.VNDetectFaceLandmarksRequest.alloc().init()
        ok, _ = handler.performRequests_error_([face_request], None)
        for item in (face_request.results() or []) if ok else []:
            box = item.boundingBox()
            if float(item.confidence()) < MIN_CONFIDENCE:
                continue
            mouth = None
            landmarks = item.landmarks()
            lips = landmarks.innerLips() if landmarks is not None else None
            count = int(lips.pointCount()) if lips is not None else 0
            if count:
                points = lips.normalizedPoints()  # normalised to the face box
                ys = [float(points[i].y) for i in range(count)]
                mouth = max(ys) - min(ys)
            faces.append({
                "x": float(box.origin.x) + float(box.size.width) / 2,
                "w": float(box.size.width),
                "h": float(box.size.height),
                "mouth": mouth,
            })
        if not faces:
            human_request = Vision.VNDetectHumanRectanglesRequest.alloc().init()
            ok, _ = handler.performRequests_error_([human_request], None)
            for item in (human_request.results() or []) if ok else []:
                box = item.boundingBox()
                people.append({"x": float(box.origin.x) + float(box.size.width) / 2,
                               "w": float(box.size.width), "h": float(box.size.height), "mouth": None})
    return {"faces": faces, "people": people}


def _apple_rectangles(jpeg: bytes) -> list[dict]:
    import Foundation
    import objc
    import Vision

    faces = []
    with objc.autorelease_pool():
        data = Foundation.NSData.dataWithBytes_length_(jpeg, len(jpeg))
        handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, {})
        request = Vision.VNDetectFaceRectanglesRequest.alloc().init()
        ok, _ = handler.performRequests_error_([request], None)
        for item in (request.results() or []) if ok else []:
            if float(item.confidence()) < MIN_CONFIDENCE:
                continue
            box = item.boundingBox()  # Vision: normalised, bottom-left origin
            w, h = float(box.size.width), float(box.size.height)
            faces.append({"x": float(box.origin.x), "y": 1.0 - float(box.origin.y) - h, "w": w, "h": h})
    return faces


# --------------------------------------------------------------------------- OpenCV + MediaPipe

def _decode(jpeg: bytes):
    import cv2
    import numpy as np

    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("The sampled frame could not be decoded.")
    return image


def _yunet_boxes(image) -> list[tuple[float, float, float, float]]:
    """Face boxes in pixels (x, y, w, h), clipped to the image, most confident first."""
    height, width = image.shape[:2]
    with _lock:
        _yunet.setInputSize((width, height))
        _, found = _yunet.detect(image)
    rows = sorted((row for row in (found if found is not None else []) if float(row[14]) >= YUNET_SCORE),
                  key=lambda row: -float(row[14]))[:MAX_FACES]
    boxes = []
    for row in rows:
        x0, y0 = max(0.0, float(row[0])), max(0.0, float(row[1]))
        x1, y1 = min(float(width), float(row[0] + row[2])), min(float(height), float(row[1] + row[3]))
        if x1 - x0 >= 2 and y1 - y0 >= 2:
            boxes.append((x0, y0, x1 - x0, y1 - y0))
    return boxes


def _mouth(image, box) -> float | None:
    """Inner-lip opening / face height on a crop around one face, or None."""
    if _landmarker is None:
        return None
    import cv2
    import mediapipe as mp

    height, width = image.shape[:2]
    x, y, w, h = box
    side = max(w, h) * CROP_SCALE
    cx, cy = x + w / 2, y + h / 2
    left, top = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    right, bottom = int(min(width, cx + side / 2)), int(min(height, cy + side / 2))
    if right - left < 8 or bottom - top < 8:
        return None
    crop = cv2.resize(cv2.cvtColor(image[top:bottom, left:right], cv2.COLOR_BGR2RGB), (CROP_SIZE, CROP_SIZE))
    with _lock:
        result = _landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop))
    if not result.face_landmarks:
        return None
    points = result.face_landmarks[0]
    ys = [float(p.y) for p in points]
    span = max(ys) - min(ys)
    if span <= 0:
        return None
    lips = [float(points[i].y) for i in INNER_LIPS]
    return (max(lips) - min(lips)) / span


def _people(image) -> list[dict]:
    height, width = image.shape[:2]
    with _lock:
        rects, weights = _hog.detectMultiScale(image, winStride=(8, 8), padding=(8, 8), scale=1.05)
    people = []
    for (x, _y, w, h), weight in zip(rects, weights, strict=False):
        if float(weight) < MIN_CONFIDENCE:
            continue
        people.append({"x": (float(x) + float(w) / 2) / width, "w": float(w) / width,
                       "h": float(h) / height, "mouth": None})
    return people


def _opencv_detect(jpeg: bytes) -> dict:
    image = _decode(jpeg)
    height, width = image.shape[:2]
    faces = [{
        "x": (x + w / 2) / width,
        "w": w / width,
        "h": h / height,
        "mouth": _mouth(image, (x, y, w, h)),
    } for x, y, w, h in _yunet_boxes(image)]
    return {"faces": faces, "people": [] if faces else _people(image)}


def _opencv_rectangles(jpeg: bytes) -> list[dict]:
    image = _decode(jpeg)
    height, width = image.shape[:2]
    return [{"x": x / width, "y": y / height, "w": w / width, "h": h / height}
            for x, y, w, h in _yunet_boxes(image)]
