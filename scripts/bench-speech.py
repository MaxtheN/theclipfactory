"""Speech benchmark: transcribe one recording the way the app does, and report speed and accuracy.

Runs the app's own inference worker in the app's installed speech runtime: MLX Whisper on Apple silicon,
faster-whisper on Windows and Linux (on an NVIDIA GPU when the app uses one, otherwise the CPU). Each run
reports its wall time (start-up and model load included, as in the app), times realtime, peak memory of
the worker, words, lines and sentence ends, word error rate against an optional reference text, and whether
it gave the same transcript as the first run. Clips and captions break at sentence ends, so fewer of them
is a regression even when the word error rate holds: word error rate ignores punctuation and capitals.

Usage (from a checkout, with the app's speech model installed):
  .venv/bin/python scripts/bench-speech.py talk.mp4 --seconds 600 --reference talk.txt --repeat 2

--device cpu measures the CPU on a computer whose app uses its NVIDIA GPU. --language is the app's language
setting (en unless changed). Peak memory is the worker's resident memory; on Apple silicon, memory the GPU
holds may not be counted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def words(text: str) -> list[str]:
    """Lower-case words without punctuation, so a comma or capital is not counted as an error."""
    text = unicodedata.normalize("NFKC", text).lower().replace("\u2019", "'")
    return [word for word in (token.strip("'") for token in re.sub(r"[^\w']+", " ", text).split()) if word]


def wer(reference: list[str], hypothesis: list[str]) -> float:
    """Word error rate: substituted, inserted and deleted words over the reference's length."""
    if not reference:
        return float(bool(hypothesis))
    previous = list(range(len(hypothesis) + 1))
    for row, expected in enumerate(reference, 1):
        current = [row]
        for column, heard in enumerate(hypothesis, 1):
            current.append(min(previous[column] + 1, current[column - 1] + 1,
                               previous[column - 1] + (expected != heard)))
        previous = current
    return previous[-1] / len(reference)


def sentence_ends(text: str) -> int:
    """Words ending in . ? or !, where the app's clip finder ends a sentence (moments.sentence_units)."""
    return sum(word.endswith((".", "?", "!")) for word in text.split())


def digest(transcript: dict) -> str:
    """The same lines with the same timings give the same digest."""
    lines = [(round(s["start"], 2), round(s["end"], 2), s["text"]) for s in transcript.get("segments", [])]
    return hashlib.sha256(json.dumps(lines, ensure_ascii=False).encode()).hexdigest()[:12]


def app_wav(path: Path) -> bool:
    """Already what the app extracts (16 kHz mono 16-bit WAV), so the worker reads it directly."""
    try:
        with wave.open(str(path), "rb") as audio:
            return (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
    except (OSError, EOFError, wave.Error):
        return False


def prepare(source: Path, folder: Path, seconds: float | None) -> Path:
    """The recording as the app's 16 kHz mono WAV, cut to its first seconds when asked."""
    if app_wav(source) and not seconds:
        return source
    from clip_factory import media

    target = folder / "audio.wav"
    command = [media.ffmpeg(), "-nostdin", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0", "-vn"]
    command += ["-t", f"{seconds:g}"] if seconds else []
    subprocess.run([*command, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)], check=True)
    return target


def duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def measure(python: Path, request: dict, folder: Path, env: dict) -> dict:
    """One transcription in a fresh worker process, as the app runs it: seconds, peak memory, result."""
    import psutil

    ask, answer = folder / "request.json", folder / "response.json"
    ask.write_text(json.dumps(request), encoding="utf-8")
    answer.unlink(missing_ok=True)
    worker = ROOT / "clip_factory" / "inference_worker.py"
    started = time.perf_counter()
    child = subprocess.Popen([str(python), str(worker), str(ask), str(answer)], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    peak = 0
    try:
        process = psutil.Process(child.pid)
        while child.poll() is None:
            try:
                peak = max(peak, sum(p.memory_info().rss for p in [process, *process.children(recursive=True)]))
            except psutil.Error:
                pass
            time.sleep(0.1)
    except psutil.Error:
        child.wait()
    seconds = time.perf_counter() - started
    if child.returncode or not answer.is_file():
        return {"seconds": seconds, "peak_gb": peak / 1e9, "failed": f"worker exited with {child.returncode}"}
    return {"seconds": seconds, "peak_gb": peak / 1e9, "result": json.loads(answer.read_text(encoding="utf-8"))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("audio", type=Path, help="a recording: any audio or video FFmpeg reads")
    parser.add_argument("--reference", type=Path, help="the recording's correct transcript, as plain text")
    parser.add_argument("--seconds", type=float, help="only the first seconds of the recording")
    parser.add_argument("--repeat", type=int, default=1, help="runs, to check each gives the same transcript")
    parser.add_argument("--device", choices=["cpu", "cuda"], help="faster-whisper device (default: the app's)")
    parser.add_argument("--language", default="en", help="the app's language setting (default: en)")
    parser.add_argument("--data-dir", type=Path, help="the app's data folder (default: this user's)")
    parser.add_argument("--json", type=Path, help="also append one JSON line per run to this file")
    args = parser.parse_args(argv)
    if args.repeat < 1:
        parser.error("--repeat takes 1 or more runs")

    from platformdirs import user_data_path

    from clip_factory import inference_worker, speech_backend
    from clip_factory.models import Models, child_env

    root = Path(args.data_dir or user_data_path("Clip Factory", appauthor=False)).expanduser()
    if not (root / "models" / "whisper-turbo").is_dir():
        raise SystemExit(f"No speech model under {root}: set up local speech in the app first, or pass --data-dir.")
    models = Models(root, jobs=None)
    status = models.speech_status()
    engine, device = status["backend"], args.device or status["device"]
    if engine not in {speech_backend.MLX, speech_backend.FASTER_WHISPER} or not models.python.is_file():
        raise SystemExit(f"Local speech is not set up on this computer ({status['detail']}).")
    if engine == speech_backend.MLX and args.device:
        raise SystemExit("--device is for faster-whisper; MLX Whisper runs on the Apple GPU.")
    request = {"action": "transcribe", "model": str(models.model_dir / "whisper-turbo"), "language": args.language,
               "engine": engine}
    if engine == speech_backend.FASTER_WHISPER:
        request["device"] = device
    reference = words(args.reference.read_text(encoding="utf-8")) if args.reference else None
    print(f"{platform.system()} {platform.machine()} | {status['label']} | {device} | {root}")

    with tempfile.TemporaryDirectory(prefix="bench-speech-") as scratch:
        folder = Path(scratch)
        request["audio"] = str(prepare(args.audio.resolve(), folder, args.seconds))
        inference_worker.validate_request(request)
        length = duration(Path(request["audio"]))
        print(f"{Path(request['audio']).name}: {length:.1f} s of audio\n")
        print(f"{'setting':<14}{'run':>4}{'seconds':>10}{'realtime':>10}{'peak GB':>9}{'words':>8}{'lines':>7}"
              f"{'sentences':>11}{'WER':>8}  same as run 1")
        first = None
        for run in range(1, args.repeat + 1):
            outcome = measure(models.python, request, folder, child_env())
            result = outcome.get("result")
            if result is None:
                print(f"{engine:<14}{run:>4}{outcome['seconds']:>10.1f}  {outcome['failed']}")
                continue
            # Where it ran: a CUDA failure falls back to the CPU, as in the app.
            setting = " ".join(filter(None, [result.get("device"), result.get("compute_type")])) or engine
            heard = words(result.get("text", ""))
            first = first or digest(result)
            row = {
                "setting": setting, "run": run, "seconds": round(outcome["seconds"], 1),
                "realtime": round(length / outcome["seconds"], 2), "peak_gb": round(outcome["peak_gb"], 2),
                "words": len(heard), "lines": len(result.get("segments", [])),
                "sentences": sentence_ends(result.get("text", "")),
                "wer": round(wer(reference, heard), 4) if reference is not None else None,
                "same": digest(result) == first, "engine": engine, "system": platform.system(),
                "machine": platform.machine(), "audio_seconds": round(length, 1),
            }
            shown = "-" if row["wer"] is None else f"{row['wer']:.2%}"
            print(f"{setting:<14}{run:>4}{row['seconds']:>10.1f}{row['realtime']:>9.2f}x{row['peak_gb']:>9.2f}"
                  f"{row['words']:>8}{row['lines']:>7}{row['sentences']:>11}{shown:>8}  "
                  f"{'yes' if row['same'] else 'NO'}")
            if args.json:
                with args.json.open("a", encoding="utf-8") as log:
                    log.write(json.dumps(row) + "\n")


if __name__ == "__main__":
    main()
