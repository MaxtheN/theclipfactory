"""The contract every renderer extension implements (stdlib only, imported by generated code).

An extension is one module ``clip_factory/extensions/<capability>.py`` that declares:

    CAPABILITY = "progress_bar"            # equals the module name
    LABEL = "Progress bar"                 # Fine-tune toggle label
    DESCRIPTION = "A thin bar that fills left to right over the clip."
    PARAMS = {"color": {"type": "color", "default": "#FFD400"}, ...}
    PROVENANCE = "factory_builder:<request id>" (or "manual")

    def build(geometry: Geometry, timing: Timing, params: dict) -> Fragment: ...

``build`` is a pure function: no I/O, no subprocess, no network, no imports beyond the stdlib
modules the registry allows and this module. It returns linear FFmpeg 4.4 video filter fragments
(appended to the final 1080x1920 chain) and/or ASS ``Dialogue:`` events burned by libass. The
renderer validates every fragment again before it touches FFmpeg, and an extension is always off
unless a render request names it in ``CraftOptions.extensions``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

WIDTH = 1080
HEIGHT = 1920
FPS = 30

# Simple per-frame filters that read no files and need no extra inputs. Anything else
# (movie, subtitles/ass, drawtext with textfile/fontfile, amovie, split/overlay graphs) is refused.
ALLOWED_FILTERS = frozenset({
    "drawbox", "drawgrid", "eq", "hue", "vignette", "colorbalance", "colorchannelmixer", "unsharp",
    "boxblur", "gblur", "scale", "crop", "pad", "fade", "negate", "noise", "format", "setsar", "null",
    "rotate", "lutrgb", "lutyuv", "curves", "colorlevels", "chromashift",
})
# Substrings that would make an allowed filter read a file or take commands (e.g. curves=psfile).
FORBIDDEN_TOKENS = ("file", "movie", "subtitles", "ass=", "url", "http", "sendcmd", "zmq", ":/", "~")
FILTER_PATTERN = re.compile(r"^([a-z][a-z0-9_]{1,30})(=[^;\[\]\n\r]{0,1500})?$")
MAX_FILTERS = 8
MAX_EVENTS = 400
MAX_EVENT_CHARS = 2000
MAX_STYLES = 6
PARAM_TYPES = {"bool", "int", "float", "enum", "color"}
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


@dataclass(frozen=True)
class Geometry:
    """The output frame and its 9:16 safe area (captions sit near the bottom margin)."""

    width: int = WIDTH
    height: int = HEIGHT
    fps: int = FPS
    safe_left: int = 72
    safe_right: int = WIDTH - 72
    safe_top: int = 220
    safe_bottom: int = HEIGHT - 320


@dataclass(frozen=True)
class Timing:
    """Seconds on the rendered (cut, re-ordered) output timeline."""

    duration: float
    hook_seconds: float = 0.0
    end_card_start: float | None = None
    cuts: tuple[float, ...] = ()


@dataclass(frozen=True)
class Fragment:
    video_filters: tuple[str, ...] = ()
    ass_events: tuple[str, ...] = ()
    # Extra ASS "Style:" lines; the document already defines a style named "Ext".
    ass_styles: tuple[str, ...] = ()
    notes: dict = field(default_factory=dict)


class ExtensionError(ValueError):
    pass


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def ass_time(seconds: float) -> str:
    """ASS timestamp H:MM:SS.cc."""
    centis = round(max(0.0, float(seconds)) * 100)
    hours, rest = divmod(centis, 360000)
    minutes, rest = divmod(rest, 6000)
    secs, cs = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def ass_color(hex_color: str, alpha: int = 0) -> str:
    """#RRGGBB → &HAABBGGRR (alpha 0 = opaque, 255 = transparent)."""
    if not HEX.match(hex_color or ""):
        raise ExtensionError("Colours must be #RRGGBB.")
    r, g, b = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"&H{int(clamp(alpha, 0, 255)):02X}{b}{g}{r}".upper()


def ffmpeg_color(hex_color: str, opacity: float = 1.0) -> str:
    """#RRGGBB → 0xRRGGBB@opacity for drawbox and friends."""
    if not HEX.match(hex_color or ""):
        raise ExtensionError("Colours must be #RRGGBB.")
    return f"0x{hex_color[1:].upper()}@{clamp(opacity, 0.0, 1.0):.2f}"


def dialogue(start: float, end: float, text: str, *, style: str = "Ext", layer: int = 5) -> str:
    """One ASS Dialogue line; ``text`` may carry override tags and drawing commands."""
    if "\n" in text or "\r" in text:
        raise ExtensionError("ASS event text must be one line.")
    return f"Dialogue: {int(layer)},{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{text}"


def validate_params(schema: dict, params: dict | None) -> dict:
    """Defaults filled in, unknown keys refused, each value checked against its declared type."""
    params = dict(params or {})
    unknown = set(params) - set(schema)
    if unknown:
        raise ExtensionError(f"Unknown setting: {min(unknown)[:40]}")
    out = {}
    for name, spec in schema.items():
        kind = spec.get("type")
        value = params.get(name, spec.get("default"))
        if kind == "bool":
            if type(value) is not bool:
                raise ExtensionError(f"{name} must be true or false.")
        elif kind in {"int", "float"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ExtensionError(f"{name} must be a number.")
            if kind == "int" and int(value) != value:
                raise ExtensionError(f"{name} must be a whole number.")
            low, high = spec.get("min"), spec.get("max")
            if (low is not None and value < low) or (high is not None and value > high):
                raise ExtensionError(f"{name} must be between {low} and {high}.")
            value = int(value) if kind == "int" else float(value)
        elif kind == "enum":
            if value not in (spec.get("values") or ()):
                raise ExtensionError(f"{name} must be one of: {', '.join(map(str, spec.get('values') or ()))}.")
        elif kind == "color":
            if not isinstance(value, str) or not HEX.match(value):
                raise ExtensionError(f"{name} must be a #RRGGBB colour.")
        else:
            raise ExtensionError(f"{name} has an unknown type.")
        out[name] = value
    return out


def check_schema(schema) -> list[str]:
    problems = []
    if not isinstance(schema, dict) or len(schema) > 12:
        return ["PARAMS must be a dict of at most 12 settings."]
    for name, spec in schema.items():
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,30}", name):
            problems.append(f"Setting name {str(name)[:40]!r} must be snake_case.")
            continue
        if not isinstance(spec, dict) or spec.get("type") not in PARAM_TYPES or "default" not in spec:
            problems.append(f"Setting {name} needs a type in {sorted(PARAM_TYPES)} and a default.")
            continue
        try:
            validate_params({name: spec}, {})
        except ExtensionError as exc:
            problems.append(f"Default of {name} is invalid: {exc}")
    return problems


def check_fragment(fragment) -> list[str]:
    """Problems with a build() result; an empty list means the renderer may use it."""
    if not isinstance(fragment, Fragment):
        return ["build() must return a Fragment."]
    problems = []
    filters, events, styles = fragment.video_filters, fragment.ass_events, fragment.ass_styles
    if not all(isinstance(x, tuple) for x in (filters, events, styles)):
        return ["Fragment fields must be tuples of strings."]
    if len(filters) > MAX_FILTERS or len(events) > MAX_EVENTS or len(styles) > MAX_STYLES:
        problems.append("Fragment is too large.")
    for item in filters:
        match = FILTER_PATTERN.match(item) if isinstance(item, str) else None
        if not match:
            problems.append(f"Filter {str(item)[:60]!r} is not one simple filter.")
            continue
        if match.group(1) not in ALLOWED_FILTERS:
            problems.append(f"Filter {match.group(1)!r} is not allowed.")
        if any(token in item.lower() for token in FORBIDDEN_TOKENS):
            problems.append(f"Filter {match.group(1)!r} references a file, URL or command.")
    for item in events:
        if not isinstance(item, str) or not item.startswith("Dialogue: ") or len(item) > MAX_EVENT_CHARS:
            problems.append("Each ASS event must be one Dialogue: line under 2000 characters.")
        elif "\n" in item or "\r" in item:
            problems.append("ASS events must be single lines.")
    for item in styles:
        if not isinstance(item, str) or not item.startswith("Style: ") or "\n" in item or len(item) > 400:
            problems.append("Each ASS style must be one Style: line.")
    return problems


def ass_document(fragments: list[Fragment], geometry: Geometry | None = None) -> str:
    geometry = geometry or Geometry()
    styles, events = [], []
    for fragment in fragments:
        styles.extend(fragment.ass_styles)
        events.extend(fragment.ass_events)
    header = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {geometry.width}", f"PlayResY: {geometry.height}",
        "WrapStyle: 2", "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
        "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding"),
        "Style: Ext,Liberation Sans,56,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,7,0,0,0,1",
        *styles, "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events,
    ]
    return "\n".join(header) + "\n"
