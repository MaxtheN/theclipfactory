# Local model setup

Hardware verified on this Mac: Apple M5,16 GiB unified memory,about360 GiB available storage at setup time. Local FFmpeg and ffprobe are installed under `/Users/kartikbihani/WIN/.growth-factory-tools/bin`; prepend that directory for this development session. No global PATH was modified.

Use a small vision model for the first agent run, one heavy task at a time. The selected setup candidate is Ollama `qwen3-vl:4b-instruct` (official listing3.3GB,Q4_K_M,Apache2), plus the app's catalogued MLX Whisper large-v3-turbo for source speech. This is a fit/latency choice for16GiB, not a claim of best editorial quality. Larger models should wait for a measured comparison. Ollama uses loopback only. The app also supports optional OpenRouter cloud routing; enabling it sends the relevant role inputs to that provider, with still-frame sharing separately controlled. This page covers the local setup only. The connector unloads after each task to free memory for Whisper/rendering.

Model downloads/runtime installs are opt-in operations separate from ordinary upload. Installation success, ready-state probes, a tiny model call, and a complete real agent-to-render run are distinct gates. See the external runtime evidence/readout for current gate results; this document alone does not certify installed or working models.

The first real All-In media smoke produced2hook variants and1linked revision with verified exports and no invented subtitles. Those fixed-range media tests did not run AI selection or speech transcription. Follow with a short derived excerpt through actual Whisper and vision-agent production before testing the full85-minute source.

Sources: https://ollama.com/library/qwen3-vl:4b-instruct ; the repository's `clip_factory/models.py` catalog and `clip_factory/ollama.py` connector. No paid inference or social actions are part of this setup.

## Verified execution progress

The official signed/notarized Ollama0.40.16 app and Qwen3-VL4B-Instruct are installed locally. The pinned MLX runtime and Whisper Turbo model passed installation checks. After the user freed memory, the unchanged5GB ASR safety check passed: real60-second All-In transcription completed in6.2seconds with10timed cues and174word timestamps. An actual extracted-frame Qwen vision call completed successfully. Full production output and campaign-scoped team execution are later gates; do not infer success from these individual steps.

Final verification: local baseline produced3captioned drafts; one campaign-scoped team run produced a checked unapproved draft with an explicit same-source fallback. A deliberate substantive90-second excerpt then produced a complete15.1-second captioned point in one119.2-second team run, with fresh grounded footage analysis and no fallback. Source boundaries matched word timestamps; critic and technical checks passed. All outputs remain unapproved for human editorial review. The full85-minute source and audience improvement are untested.

## Speech on Windows and Linux

Which speech engine a computer gets is decided in [`clip_factory/speech_backend.py`](../clip_factory/speech_backend.py):

| Computer | Engine | Device | One-time download |
|---|---|---|---|
| Apple Silicon Mac | MLX Whisper large-v3-turbo | Apple GPU | about 1.4 GB packages + 1.6 GB model |
| Windows or Linux, x64 | faster-whisper 1.2.1 with CTranslate2 4.9.0, Whisper large-v3-turbo ([CTranslate2 conversion](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo)) | NVIDIA GPU (float16) when `nvidia-smi` finds one; otherwise the CPU (float32) | about 0.2 GB packages (+1.3 GB NVIDIA cuBLAS/cuDNN on a computer with an NVIDIA GPU) + 1.6 GB model |
| Intel Mac, ARM Windows or Linux | none | n/a | Setup is not offered. Use cloud speech (Groq) or write the transcript by hand. |

On Windows and Linux the runtime is speech-only. It uses the same app-owned, checksum-pinned Python 3.12.16 (python-build-standalone 20261110, a separate archive for each platform) and the same isolated venv, ready marker and import probe as the Mac runtime. The venv's interpreter is `runtime\Scripts\python.exe` on Windows. Once set up, transcription is offline. If CUDA fails for any reason, the worker transcribes on the CPU and reports the device it used. `/api/system` reports the engine and device under `speech`.

Pinned packages: `faster-whisper==1.2.1`, `ctranslate2==4.9.0`, `av==18.0.0` (faster-whisper 1.2.1 calls `av.open(metadata_errors=...)`, which PyAV 19 removed). With an NVIDIA GPU, setup also installs `nvidia-cublas-cu12==12.9.2.10` (the newest cuBLAS 12 with a Windows wheel) and `nvidia-cudnn-cu12==9.28.1.4`.

### CPU benchmark

The benchmark ran 10 minutes of English speech (LibriVox, *The Count of Monte Cristo*, chapter 1, public domain) as 16 kHz mono WAV. It used an 8-vCPU Intel Xeon x86_64 cloud VM with 31 GB RAM and no GPU, `cpu_threads=8`, greedy decoding, VAD and word timestamps. RTF is processing time divided by audio length; lower is faster.

| Model | Compute type | Time for 10 min | RTF | Words | Same transcript every run? |
|---|---|---|---|---|---|
| large-v3-turbo (**default**) | float32 | 190 s | 0.32 | 1549 | yes (3 of 3 identical on a 60 s cut) |
| large-v3-turbo | int16 | about 16–19 s per 60 s | about 0.29 | n/a | yes (3 of 3 identical) |
| large-v3-turbo | int8 | 83–88 s | 0.14–0.15 | 1409–1532 | **no**: runs differed and some lost whole sentences (one dropped the first 23 s of a 60 s cut) |
| small | int8 | 42 s | 0.07 | 1537 | not checked |

The CPU default is float32. int8 is about twice as fast, but on this CPU it gave a different transcript on each run of the same audio, and some runs silently lost speech. MKL's `MKL_CBWR=COMPATIBLE` made int8 repeatable, but about 10× slower. float32 gives the same complete transcript every run and behaves the same on Intel and AMD processors (CTranslate2's int16 path depends on Intel MKL).

The worker decodes the app's 16 kHz mono WAV itself, so transcription does not depend on PyAV's audio API. A creator's 30-minute source takes about 10 minutes to transcribe on a CPU like this one. GPU speed was not measured (no NVIDIA GPU was available for this benchmark).

## Agents on Windows and Linux

Which agent engine a computer gets, and which model fits it, is decided in [`clip_factory/local_agents.py`](../clip_factory/local_agents.py). Apple Silicon keeps MLX. Every other computer runs its agents through [Ollama](https://ollama.com/download), which the creator installs; the app detects it but never installs it.

| Model | Download | Fits when | Notes |
|---|---|---|---|
| `qwen3-vl:4b-instruct` (**recommended**) | 3.3 GB | 12 GB RAM, or 8 GB RAM plus an NVIDIA GPU with 5 GB VRAM | Every feature, including the strategist, brand research, references and post copy, which are qualified on this model only |
| `qwen3-vl:2b-instruct` | 1.9 GB | 8 GB RAM, or 3 GB VRAM | Clip production only; the 4B-only features stay unavailable |

Both are Apache-2.0 and accept still frames. Download sizes come from the Ollama registry manifests. RAM is read with psutil and allows 0.6 GB for the memory the system reserves, so a 12 GB computer counts as 12 GB. VRAM is read once from `nvidia-smi --query-gpu=memory.total`, taking the largest GPU. The 8B model (6.2 GB) is not offered: no feature is qualified on it.

The check runs before production starts, not partway through. In order, the app reports:

1. under 8 GB RAM: no local model fits; add an OpenRouter key under Brand profile → AI model, or write the work by hand;
2. Ollama not installed: a link to the download page, then **Check again**;
3. Ollama installed but not running: start it, then **Check again**;
4. no fitting model: download the recommended model through Ollama (a network download of the stated size).

With a saved OpenRouter key and cloud agents on, the check is skipped.

Calls through Ollama are recorded with provider `ollama`, the model and token counts, at no cost. Memory pressure for the local-resource guard comes from psutil on Windows and Linux (under 10 % of RAM available is a warning, under 5 % is critical). The guard needs at least 6 GiB available, or the model plus 3 GiB, before each strategist, brand research, references, post copy or learning call, so a 12 GB computer with other apps open may be held there. Speed on Windows and Linux has not been measured.
