"""Speaker/face-aware 9:16 reframing: a smoothed horizontal crop path that follows the subject.

For `framing="fill"` on landscape sources (`craft.CraftOptions.crop_focus="auto_face"`), the
renderer samples each source window at ~2.5 fps (640 px JPEGs piped from FFmpeg, never the whole
clip in memory), finds faces on-device (`faces.py`: Apple Vision on macOS, OpenCV YuNet with MediaPipe landmarks on
Windows and Linux), picks the
active subject per sample, and turns the picks into a smoothed crop-centre path:

* hold the last position through brief misses; median filter against single-sample noise;
* a dead zone so small head movements never move the frame; a critically damped follower with a
  maximum pan speed so it never whips;
* a hard snap (never a pan) at every picture cut: measured by FFmpeg scene detection in the same
  decode pass, plus storyboard scene starts when given.

The path becomes a flat piecewise-linear FFmpeg expression of `t` for `crop`'s `x` (evaluated
per frame in FFmpeg 4.4, no sendcmd file). The pure functions here are deterministic and tested
without a detector; `plan()` returns `None` path plus a reason whenever the detector is unavailable
or the evidence is too thin, and the renderer then keeps the fixed `focus_x` crop.
"""

from __future__ import annotations

import itertools
import math
import subprocess
import tempfile
import time
from pathlib import Path

from . import faces

SAMPLE_FPS = 2.5
SAMPLE_WIDTH = 640
MAX_SECONDS = 180.0          # skip reframing for longer windows (bounded time)
MAX_SAMPLES = 480
MIN_FACE_SHARE = 0.25        # faces must be found in at least this share of samples
SCENE_THRESHOLD = 0.3        # FFmpeg scene score treated as a picture cut
TIMEOUT = 240

# Path shaping, in fractions of the source width and seconds.
DEAD_ZONE = 0.035            # ignore subject movement smaller than this
MAX_SPEED = 0.18             # maximum pan speed (source widths per second)
SMOOTH_TIME = 0.6            # critically damped follower time constant
HOLD_SECONDS = 2.0           # keep the last position this long through detection misses
MEDIAN_WINDOW = 3
SWITCH_SAMPLES = 3           # another face must win this many samples in a row to take over
SWITCH_MARGIN = 1.25
SNAP_SECONDS = 0.001         # width of the step at a cut in the expression
MAX_KEYFRAMES = 60           # bounded expression length
SIMPLIFY_TOLERANCE = 0.004

# --------------------------------------------------------------------------- detector

def available() -> tuple[bool, str | None]:
    """(True, None) when this computer has a face detector, else (False, reason). Cached."""
    return faces.available()


def detect(jpeg: bytes) -> dict:
    """Faces (and people when no face is found) in one image, in normalised [0, 1] coordinates.

    Each face: {"x": centre x, "w": width, "h": height, "mouth": inner-lip opening / face height}.
    """
    return faces.detect(jpeg)


# --------------------------------------------------------------------------- sampling

def split_jpegs(stream: bytes) -> list[bytes]:
    """FFmpeg's mjpeg image2pipe output, one JPEG per frame (SOI ... EOI)."""
    frames, at = [], 0
    while True:
        begin = stream.find(b"\xff\xd8", at)
        if begin < 0:
            break
        end = stream.find(b"\xff\xd9\xff\xd8", begin + 2)
        stop = len(stream) if end < 0 else end + 2
        frames.append(stream[begin:stop])
        at = stop
    return frames


def parse_cuts(text: str) -> list[float]:
    """pts_time of frames FFmpeg's metadata=print logged (scene score above threshold)."""
    cuts = []
    for line in text.splitlines():
        if "pts_time:" in line:
            try:
                cuts.append(float(line.split("pts_time:")[1].split()[0]))
            except (IndexError, ValueError):
                continue
    return cuts


def sample(ffmpeg: str, source: Path, start: float, span: float) -> tuple[list[tuple[float, bytes]], list[float]]:
    """(samples [(window time, jpeg)], cut times) for one source window in one decode pass."""
    with tempfile.TemporaryDirectory(prefix="reframe-") as folder:
        graph = (
            f"[0:v]split[s][c];[s]fps={SAMPLE_FPS},scale={SAMPLE_WIDTH}:-2[out];"
            f"[c]scale=160:-2,select='gt(scene,{SCENE_THRESHOLD})',metadata=print:file=cuts.txt[cuts]"
        )
        result = subprocess.run(
            [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.6f}", "-t", f"{span:.6f}",
             "-i", str(source), "-filter_complex", graph,
             "-map", "[out]", "-an", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1",
             "-map", "[cuts]", "-an", "-f", "null", "-"],
            cwd=folder, capture_output=True, timeout=TIMEOUT, check=True,
        )
        cuts_file = Path(folder) / "cuts.txt"
        cuts = parse_cuts(cuts_file.read_text(errors="replace")) if cuts_file.exists() else []
    frames = split_jpegs(result.stdout)[:MAX_SAMPLES]
    return [(index / SAMPLE_FPS, frame) for index, frame in enumerate(frames)], cuts


# --------------------------------------------------------------------------- subject choice

def choose(samples: list[tuple[float, dict]], crop: float) -> list[tuple[float, float | None, str | None]]:
    """Per sample: (t, subject centre x or None, "face" | "person" | None).

    Faces are tracked across samples by nearest centre. The current subject is kept unless
    another face scores clearly higher (size, centrality, mouth movement) for SWITCH_SAMPLES
    samples in a row. When the main faces fit inside the crop together, frame their midpoint.
    """
    tracks: list[dict] = []        # {"x", "mouth", "motion", "seen"}
    current: int | None = None
    challenger: tuple[int | None, int] = (None, 0)
    out: list[tuple[float, float | None, str | None]] = []
    for index, (t, found) in enumerate(samples):
        faces = found.get("faces") or []
        if not faces:
            people = found.get("people") or []
            if people:
                person = max(people, key=lambda p: p["w"] * p["h"])
                out.append((t, person["x"], "person"))
            else:
                out.append((t, None, None))
            continue
        ids = []
        for face in faces:
            nearest = min(
                (i for i, tr in enumerate(tracks) if tr["seen"] >= index - 4 and i not in ids),
                key=lambda i: abs(tracks[i]["x"] - face["x"]),
                default=None,
            )
            if nearest is not None and abs(tracks[nearest]["x"] - face["x"]) < max(0.06, face["w"]):
                track = tracks[nearest]
                if face["mouth"] is not None and track["mouth"] is not None:
                    track["motion"] = 0.6 * track["motion"] + 0.4 * abs(face["mouth"] - track["mouth"])
                track.update(x=face["x"], mouth=face["mouth"], seen=index, w=face["w"])
                ids.append(nearest)
            else:
                tracks.append({"x": face["x"], "mouth": face["mouth"], "motion": 0.0, "seen": index, "w": face["w"]})
                ids.append(len(tracks) - 1)
        largest = max(f["w"] * f["h"] for f in faces)

        def score(i: int, face: dict, largest: float = largest) -> float:
            size = face["w"] * face["h"] / largest
            central = 1 - min(1.0, abs(face["x"] - 0.5) * 2)
            return size + 0.15 * central + 8.0 * tracks[i]["motion"]

        scores = {i: score(i, f) for i, f in zip(ids, faces)}
        best = max(scores, key=scores.get)
        if current not in scores:
            current, challenger = best, (None, 0)
        elif best != current and scores[best] > scores[current] * SWITCH_MARGIN:
            run = challenger[1] + 1 if challenger[0] == best else 1
            challenger = (best, run)
            if run >= SWITCH_SAMPLES:
                current, challenger = best, (None, 0)
        else:
            challenger = (None, 0)
        chosen = faces[ids.index(current)]
        # Main faces (at least half the largest) that fit together inside the crop: frame them all.
        main = [f for f in faces if f["w"] * f["h"] >= 0.5 * largest]
        left = min(f["x"] - f["w"] / 2 for f in main)
        right = max(f["x"] + f["w"] / 2 for f in main)
        centre = (left + right) / 2 if len(main) > 1 and right - left <= crop * 0.85 else chosen["x"]
        out.append((t, centre, "face"))
    return out


# --------------------------------------------------------------------------- path shaping (pure)

def hold(targets: list[tuple[float, float | None]], seconds: float = HOLD_SECONDS) -> list[tuple[float, float | None]]:
    """Carry the last seen centre through misses up to `seconds`; back-fill the opening misses."""
    out, last, last_t = [], None, None
    for t, x in targets:
        if x is not None:
            last, last_t = x, t
            out.append((t, x))
        elif last is not None and t - last_t <= seconds:
            out.append((t, last))
        else:
            out.append((t, None))
    first = next((x for _, x in out if x is not None), None)
    filled, seen = [], False
    for t, x in out:
        seen = seen or x is not None
        filled.append((t, x if seen else first))
    return filled


def median(values: list[float], window: int = MEDIAN_WINDOW) -> list[float]:
    half = window // 2
    out = []
    for i in range(len(values)):
        part = sorted(values[max(0, i - half): i + half + 1])
        out.append(part[len(part) // 2])
    return out


def follow(times: list[float], targets: list[float], *, dead_zone: float = DEAD_ZONE,
           max_speed: float = MAX_SPEED, smooth: float = SMOOTH_TIME) -> list[float]:
    """Critically damped follower toward a dead-zoned goal, with a pan-speed limit.

    The goal moves only when the target leaves the dead zone around it, so a steady subject
    gives a perfectly still frame. Integrated in small steps between samples.
    """
    if not targets:
        return []
    position, velocity, goal = targets[0], 0.0, targets[0]
    out = [position]
    omega = 2.0 / max(smooth, 1e-3)
    for i in range(1, len(targets)):
        if abs(targets[i] - goal) > dead_zone:
            goal = targets[i]
        dt = max(0.0, times[i] - times[i - 1])
        steps = max(1, math.ceil(dt / 0.05))
        h = dt / steps
        for _ in range(steps):
            accel = omega * omega * (goal - position) - 2 * omega * velocity
            velocity = max(-max_speed, min(max_speed, velocity + accel * h))
            position += velocity * h
        out.append(position)
    return out


def segments(times: list[float], cuts: list[float]) -> list[list[int]]:
    """Sample indices grouped between cuts (a cut at c starts a new group at the first t >= c)."""
    groups: list[list[int]] = [[]]
    pending = sorted(c for c in cuts if c > 0)
    for i, t in enumerate(times):
        crossed = False
        while pending and t >= pending[0]:
            pending.pop(0)
            crossed = True
        if crossed and groups[-1]:
            groups.append([])
        groups[-1].append(i)
    return [g for g in groups if g]


def clamp_centre(x: float, crop: float) -> float:
    return min(1 - crop / 2, max(crop / 2, x))


def build_path(targets: list[tuple[float, float | None]], cuts: list[float], crop: float, *,
               default: float = 0.5) -> list[tuple[float, float]]:
    """Keyframes [(t, crop centre 0..1)]: held, median-filtered, followed, snapped at cuts."""
    held = hold(targets)
    if not held:
        return []
    times = [t for t, _ in held]
    values = [x if x is not None else default for _, x in held]
    keys: list[tuple[float, float]] = []
    cut_times = sorted(c for c in cuts if c > 0)
    for group in segments(times, cut_times):
        group_times = [times[i] for i in group]
        smoothed = follow(group_times, median([clamp_centre(values[i], crop) for i in group]))
        if keys:
            # Snap at the cut that starts this group: hold the old framing until the cut instant.
            cut = max((c for c in cut_times if keys[-1][0] < c <= group_times[0]), default=group_times[0])
            keys.append((cut - SNAP_SECONDS, keys[-1][1]))
            keys.append((cut, smoothed[0]))
            if group_times[0] > cut:
                keys.append((group_times[0], smoothed[0]))
        else:
            keys.append((0.0, smoothed[0]))
            if group_times[0] > 0:
                keys.append((group_times[0], smoothed[0]))
        keys.extend((t, x) for t, x in zip(group_times[1:], smoothed[1:]))
    return [(round(t, 4), round(clamp_centre(x, crop), 4)) for t, x in keys]


def simplify(keys: list[tuple[float, float]], tolerance: float = SIMPLIFY_TOLERANCE,
             limit: int = MAX_KEYFRAMES) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker on the centre path; loosen until it fits the keyframe limit."""
    if len(keys) <= 2:
        return list(keys)

    def rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
        (t0, x0), (t1, x1) = points[0], points[-1]
        worst, index = -1.0, 0
        for i in range(1, len(points) - 1):
            t, x = points[i]
            expected = x0 + (x1 - x0) * ((t - t0) / (t1 - t0) if t1 > t0 else 0.0)
            if abs(x - expected) > worst:
                worst, index = abs(x - expected), i
        if worst <= eps:
            return [points[0], points[-1]]
        return rdp(points[: index + 1], eps)[:-1] + rdp(points[index:], eps)

    eps = tolerance
    out = rdp(keys, eps)
    while len(out) > limit:
        eps *= 1.6
        out = rdp(keys, eps)
    return out


def expression(keys: list[tuple[float, float]]) -> str:
    """Flat piecewise-linear expression of t (no nesting): c0 + sum(d_i * clip((t-t_i)/dt_i, 0, 1))."""
    if not keys:
        return "0.5"
    parts = [f"{keys[0][1]:.4f}"]
    for (t0, x0), (t1, x1) in itertools.pairwise(keys):
        delta = x1 - x0
        if abs(delta) < 1e-5:
            continue
        span = max(t1 - t0, 1e-4)
        parts.append(f"{delta:+.4f}*clip((t-{t0:.4f})/{span:.4f},0,1)")
    return "".join(parts)


def crop_filter(keys: list[tuple[float, float]]) -> str:
    """FFmpeg 4.4 `crop` keeping a full-height 9:16 slice whose centre follows the path."""
    centre = expression(keys)
    return (
        "crop=w='2*trunc(ih*9/32)':h=ih:"
        f"x='max(0,min(iw-ow,({centre})*iw-ow/2))':y=0,"
    )


# --------------------------------------------------------------------------- plan

def plan(ffmpeg: str, source: Path, windows: list[dict], *, width: int, height: int,
         scene_cuts: list[float] | None = None, default: float = 0.5, detector=None) -> dict:
    """Crop filters per window, or a reason to keep the fixed crop.

    windows: [{"start": source seconds, "span": seconds}]. Returns {"status": "applied" |
    "unavailable" | "skipped" | "fallback", "filters": [str per window] (applied only), "summary"}.
    `default` (the fixed focus_x) is used where no subject was seen for longer than HOLD_SECONDS.
    `detector` replaces the face detector in tests.
    """
    began = time.monotonic()
    state = faces.status() if detector is None else {"backend": "injected", "mouth": True}
    summary: dict = {"mode": "auto_face", "detector": state["backend"]}
    if not state["mouth"]:
        summary["mouth"] = state.get("mouth_reason")
    if width <= 0 or height <= 0 or width / height < 9 / 16 * 1.15:
        return {"status": "skipped", "summary": summary | {"reason": "The source is not wider than 9:16."}}
    total = sum(w["span"] for w in windows)
    if total > MAX_SECONDS:
        return {"status": "skipped", "summary": summary | {"reason": f"Windows total {total:.0f} s, over {MAX_SECONDS:.0f} s."}}
    if detector is None:
        ok, reason = available()
        if not ok:
            return {"status": "unavailable", "summary": summary | {"reason": reason}}
        detector = detect
    crop = min(1.0, (height * 9 / 16) / width)
    filters, counts = [], {"samples": 0, "faces": 0, "people": 0, "cuts": 0, "keyframes": 0}
    paths = []
    for window in windows:
        try:
            frames, cuts = sample(ffmpeg, source, window["start"], window["span"])
            found = [(t, detector(jpeg)) for t, jpeg in frames]
        except (subprocess.SubprocessError, OSError) as exc:
            return {"status": "fallback", "summary": summary | {"reason": f"Sampling failed: {type(exc).__name__}."}}
        except Exception as exc:  # noqa: BLE001 - a detector failure must never fail the render
            return {"status": "fallback", "summary": summary | {"reason": f"Detection failed: {str(exc)[:160]}"}}
        story = [c - window["start"] for c in scene_cuts or [] if window["start"] < c < window["start"] + window["span"]]
        all_cuts = sorted(cuts + [c for c in story if all(abs(c - d) > 0.5 for d in cuts)])
        picks = choose(found, crop)
        keys = simplify(build_path([(t, x) for t, x, _ in picks], all_cuts, crop, default=default))
        counts["samples"] += len(found)
        counts["faces"] += sum(1 for _, _, kind in picks if kind == "face")
        counts["people"] += sum(1 for _, _, kind in picks if kind == "person")
        counts["cuts"] += len(all_cuts)
        counts["keyframes"] += len(keys)
        filters.append(crop_filter(keys))
        paths.append(keys)
    share = counts["faces"] / counts["samples"] if counts["samples"] else 0.0
    summary |= counts | {
        "face_share": round(share, 3),
        "crop_width": round(crop, 4),
        "seconds": round(time.monotonic() - began, 2),
        "path": [[[round(t, 2), round(x, 3)] for t, x in keys[:20]] for keys in paths],
    }
    if share < MIN_FACE_SHARE:
        return {"status": "fallback", "summary": summary | {"reason": f"Faces found in only {share:.0%} of samples."}}
    return {"status": "applied", "filters": filters, "summary": summary}
