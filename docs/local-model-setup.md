# Local model setup

Hardware verified on this Mac: Apple M5,16 GiB unified memory,about360 GiB available storage at setup time. Local FFmpeg and ffprobe are installed under `/Users/kartikbihani/WIN/.growth-factory-tools/bin`; prepend that directory for this development session. No global PATH was modified.

Use a small vision model for the first agent run, one heavy task at a time. The selected setup candidate is Ollama `qwen3-vl:4b-instruct` (official listing3.3GB,Q4_K_M,Apache2), plus the app's catalogued MLX Whisper large-v3-turbo for source speech. This is a fit/latency choice for16GiB, not a claim of best editorial quality. Larger models should wait for a measured comparison. Ollama uses loopback only. The app also supports optional OpenRouter cloud routing; enabling it sends the relevant role inputs to that provider, with still-frame sharing separately controlled. This page covers the local setup only. The connector unloads after each task to free memory for Whisper/rendering.

Model downloads/runtime installs are opt-in operations separate from ordinary upload. Installation success, ready-state probes, a tiny model call, and a complete real agent-to-render run are distinct gates. See the external runtime evidence/readout for current gate results; this document alone does not certify installed or working models.

The first real All-In media smoke produced2hook variants and1linked revision with verified exports and no invented subtitles. Those fixed-range media tests did not run AI selection or speech transcription. Follow with a short derived excerpt through actual Whisper and vision-agent production before testing the full85-minute source.

Sources: https://ollama.com/library/qwen3-vl:4b-instruct ; the repository's `clip_factory/models.py` catalog and `clip_factory/ollama.py` connector. No paid inference or social actions are part of this setup.

## Verified execution progress

The official signed/notarized Ollama0.40.16 app and Qwen3-VL4B-Instruct are installed locally. The pinned MLX runtime and Whisper Turbo model passed installation checks. After the user freed memory, the unchanged5GB ASR safety check passed: real60-second All-In transcription completed in6.2seconds with10timed cues and174word timestamps. An actual extracted-frame Qwen vision call completed successfully. Full production output and campaign-scoped team execution are later gates; do not infer success from these individual steps.

Final verification: local baseline produced3captioned drafts; one campaign-scoped team run produced a checked unapproved draft with an explicit same-source fallback. A deliberate substantive90-second excerpt then produced a complete15.1-second captioned point in one119.2-second team run, with fresh grounded footage analysis and no fallback. Source boundaries matched word timestamps; critic and technical checks passed. All outputs remain unapproved for human editorial review. The full85-minute source and audience improvement are untested.
