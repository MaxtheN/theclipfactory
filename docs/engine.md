# What the engine actually does

Short answer: **more than clipping and subtitles, less than a full editor.** The engine
watches and listens to a whole episode, uses local-model agents to choose moments and
write hooks, and then makes a 9:16 clip with a fixed set of FFmpeg edits. Its strength
is choosing and grounding moments. Its weakness is editing craft: no jump cuts, no
face tracking, no brand kit and no audio polish.

Code references are `file:function` under `clip_factory/` unless a path says otherwise.
Read on branch `kartik/backend-integration`. Some files had uncommitted changes from
other work at the time, and those are labelled *in flight*.

## 1. Ingest

Upload accepts MP4/MOV/MKV/WebM/M4V/AVI up to 20 GB and stores the original file
locally, with **no proxy** (`app.py:upload_video`). ffprobe then reads duration,
rotation, audio and HDR (`media.py:probe`, `is_hdr`). In `auto` autonomy, production
starts on import (`app.py:submit_production`).

## 2. Understanding

| Layer | Detail | Code |
| --- | --- | --- |
| Transcription | MLX Whisper large-v3-turbo, **with word timestamps** (`word_timestamps=True`). Loops, impossible timing and low-confidence text are removed. Each source is classified as speech *throughout* or background-only. | `inference_worker.py` (transcribe), `media.py:clean_transcript`, `classify_speech` |
| Transcript import | SRT, VTT or JSON can replace Whisper output. | `app.py:import_transcript`, `media.py:parse_transcript` |
| Signals | FFmpeg measures picture change (scene score) and RMS loudness across the whole source. No model is involved. | `media.py:signals` |
| Storyboard | Splits the source into roughly 48 scenes (max 96, 8–90 s each) at cuts. It samples 3–8 frames per scene, and the vision model returns `visual`, `action`, `on_screen_text`, `usable`, `said`, `highlight 0–10` and a reason. It is built once and reused. | `storyboard.py:plan_scenes`, `frame_times`, `observation_prompt`, `Storyboards` |
| Scene score | Without a model reading: `0.7·motion + 0.3·loudness`. With one: `0.6·highlight/10 + 0.4·measured`. | `storyboard.py:score` |
| Speakers | ❌ **No diarization or face detection.** `speaker_role` exists only as a strategist belief dimension. | `strategist.py` |

Models: the LLM/VLM is chosen per run. The default for 16 GB machines is `qwen3-vl:4b`
through Ollama (`docs/local-model-setup.md`). The catalog also lists Qwen3.5 9B and
35B-A3B (MLX) and Kokoro TTS (`models.py:CATALOG`).

## 3. Moment finding

Three modes are available: `production_strategy` = swarm (the default), team or baseline
(`app.py:Settings`).

| Mode | Agents and flow | Output |
| --- | --- | --- |
| **Swarm** | Each scene gets one short prompt and proposes up to 3 `Idea`s. Each idea has a *hypothesis* (bold_claim, question, story, lesson, contrast, emotion, humor or spectacle), a 15–40 s range, a hook of 10 words or fewer, and a caption. Hypotheses rotate per scene so the set stays varied. Ranges are fitted and snapped to sentence edges, and overlaps of more than 70% are dropped. Renders run in parallel. | ~1.2 clips per usable minute, max 150 (`team.py:_swarm`, `swarm_quotas`, `fit_range`, `snap_to_speech`) |
| **Team** | **Producer** (`Plan`) → **Footage analyst** (`Footage`: moments that cite scene IDs; code computes the times) → **Close-up** (frames around each peak: `happens`, `peak_frame`, `strength`) → **Performance analyst** (cites past feedback or experiments) → **Creative strategist** (`Angle`: hook + rationale) → **Editor** (`Candidate`: range, hook, caption, refs) → **Critic**. | 1–6 clips, default 3 (`team.py:TeamEngine.execute`, `_moments`, `_closeups`) |
| **Scouts** (long talks over 20 min, inside team or baseline) | One scout per 10-minute window reads the full transcript and 4 frames, and proposes up to 2 scored candidates. A diversity-first shortlist of 8 follows, then a selector model picks N. | `scouts.py:scout`, `shortlist`, `CRITERIA` |
| **Baseline** | One analysis pass, then a render. | `app.py:pipeline_task`, `analyze_task` |

**What goes into prompts** (`team.py:TeamEngine.create`, `_agent`, `_swarm`):

| Input | Bound | Reaches |
| --- | --- | --- |
| Brand text and objective | Brand ≤4,000 characters (swarm uses 600) | All modes |
| Campaign snapshot: approved Style rules, `profile_snapshot`, goal, `campaign_notes`, **`brief_snapshot`** | Whole JSON | Team as `campaign_snapshot`, swarm and scouts as `approved_campaign_direction` |
| Learning memory (experiments and comparisons, citable as `experiment:` and `comparison:` IDs) | 2,000 characters (swarm: 1,200) | Team and swarm |
| Strategist `selection_guidance` (a tagged block inside the approved `moment_selection`) | `strategist.py:selection_guidance` | Team and swarm |
| Previous observations: the 8 most recent clips' feedback, insights and events | ≤6 of each | Team (`create`) |

**Guardrails:** every agent output must match a Pydantic schema, and the decoder is
grammar-constrained with `narrowed`. A failed output gets one retry with
`format_correction`. Citations must point to known evidence (`_refs`). The model never
supplies timestamps. If moment selection fails, the engine falls back to the
measured-signal shortlist (`_shortlist`). Prompts are capped at 96,000 characters
(`inference_worker.MAX_PROMPT`).

## 4. Edit operations the renderer can apply today

Output is 1080×1920, 30 fps, H.264 CRF 22 with AAC 128k and faststart
(`media.py:ENCODER`, `render`).

| Operation | Status | Detail / code |
| --- | --- | --- |
| Trim to one source range | ✅ | `media.py:render` (`-ss`/`-t`) |
| Cold open (a 0.5–10 s source segment before the main range) | ✅ | `render` concat graph; `app.py:validate_opening` |
| Framing `fit` (whole picture on black) / `blur` (whole picture over a blurred copy) / `fill` (9:16 crop) | ✅ | `render.layout_for` |
| Crop position | ⚠️ | Fixed horizontal `focus_x`, set manually or chosen automatically from **motion energy** (`media.py:action_window`, `app.py:frame_action`). It applies only to landscape sources, does not follow the subject over time, and has no face or speaker detection. |
| Static zoom (`crop_width` 0.2–1) | ✅ | `render` `zoom` |
| Slow push-in (+7% over the clip) | ⚠️ | `motion="push_in"`, single segment only. No emphasis-timed punch-ins. |
| Burned captions: `standard`, `high_contrast` | ✅ | SRT + `force_style`, Arial 52/60 |
| Word-by-word `pop` captions (the spoken word turns yellow at 112% size) | ✅ | `media.py:pop_captions` → `.pop.ass` |
| Captions only where real speech happens | ✅ | `media.py:foreground`, `caption_entries` |
| Emphasis keywords / emoji / animated caption styles | ❌ | Every word is treated the same way. |
| Hook text overlay (top, first 3 s) | ✅ | `.hook.ass` in `render` |
| Title card / designed hook graphic | ❌ | The overlay is plain text on a box. |
| HDR → SDR tone mapping | ✅ | `media.py:TONEMAP` |
| Cover image | ⚠️ | Always the **first frame** at 540×960 (`app.py:render_task`). The engine does not pick a frame. |
| Silence / filler removal (jump cuts) | ❌ | Only cold open + main segments exist. |
| Loudness normalization | ❌ | `peak_level` / "Audible audio" only *check* the level. |
| Music, SFX, voice-over mix | ❌ | Kokoro TTS exists only as a standalone `/api/narrations` WAV. |
| B-roll, split screen, graphics | ❌ | The strategist prompt explicitly forbids them. |
| Progress bar, logo, brand fonts and colors, CTA end card | ❌ | Arial is hard-coded and there are no brand assets. |

## 5. Review and critic

| Element | Detail | Code |
| --- | --- | --- |
| Creative critic | Checks `context`, `claims`, `captions` and `duplicates` against the transcript and frames from inside each clip. Returns pass, revise or unknown. A "pass" that contains failures is downgraded. | `team.py:Critique`, `_agent("critic")` |
| Revision loop | Critic → producer `Revision` (revise or stop) → editor. The budget is 0–2 rounds. The Factory screen defaults to 0, while Studio and campaigns opt in. Non-progressing edits stop the loop. | `team.py:execute`, `app.py:submit_production` |
| Technical checks | Codec, dimensions, frame rate, source timing, audio stream and level, A/V length, caption timing, display time and length. A failed check means no clip is saved. | `media.py:verify` |
| Pre-post gate (*in flight*) | Decodes, 9:16, 7–90 s, audio, captions, ≤50 MB, hash, black or frozen frames. | `quality.py:evaluate` |
| Recheck | Re-runs the critic on edited metadata. | `team.py:review_clip` |
| Request change | Makes a new immutable version with `parent_clip_id`, a required `change_reason` and a `plan_changes` diff. A hook that is burned into the video cannot be edited in place. | `app.py:revision_fields`, `edit_clip` |

## 6. Inputs a user can give today

| Where | Fields |
| --- | --- |
| Onboarding / workspace (`campaigns.py:Profile`) | name, audience, brand_context, creative_preferences (UI: "Your creative direction", "What should every edit respect?") |
| Campaign (`campaigns.py:Campaign`) | objective, primary_metric, notes (≤2,000), **brief**: audience, constraints[], requested_outputs[], measurement_intent |
| Style rules (`campaigns.py:Direction`) | angles[], moment_selection, hooks[], pacing, duration_seconds (1–180), framing (`fit`/`fill`), caption_style (`standard`/`high_contrast`), editing_preferences, measurement_questions[], next_experiments[], evidence_refs, limitations, confidence |
| Fine-tune (`frontend/src/growth/Studio.tsx`) | mode (agents or manual start/end), model, correction budget, opening (text overlay or cold open + times), hook text, crop focus, captions on/off |
| Per-run direction | ⚠️ *In flight*: the UI field "What should the agents look for?" (≤500 characters, `productionContracts.ts:direction`) has no backend support yet. `campaigns.py:AgentProduction` forbids extra fields and has no `direction`, and no prompt reads it. |
| Direct render (`campaigns.py:Production`) | `instructions` (≤4,000). Stored as `creator_instructions` but **not** fed to any model. |

Only duration, framing and caption style are *enforced* in the render
(`app.py:render_team`, `pipeline_task`). Pacing, editing_preferences and the brief reach
the agents only as text.

## 7. Learning and strategist hooks

Measured experiments feed `learning_memory` into the next run's prompts and propose
rule changes for a person to approve (`learning.py:memory_digest`). The strategist adds a
`selection_guidance` block to the approved Style rules. Nothing is approved
automatically. Details are in `docs/learning-loop.md` and `docs/strategist.md`.

## 8. Performance evidence

| Fact | Source |
| --- | --- |
| 60 s of audio transcribed in 6.2 s, with 174 word timestamps | `docs/local-model-setup.md` |
| 90 s source → one critic-checked 15.1 s clip in **119.2 s** (team mode, qwen3-vl:4b) | `docs/local-model-setup.md`, `docs/submission/devpost.md` |
| 3.4 h stream: a single pass gave 72–158 s ranges, while scouts kept every clip ≤60 s and spread across the source | `scouts.py` header, `scripts/experiments/long_video_ab.py` |
| Swarm at ~1.2 clips per usable minute | A design **target** (`team.py:SWARM_CLIPS_PER_MINUTE`), not measured |
| A full 85-minute episode end to end, and audience lift | **Untested** (`docs/local-model-setup.md`) |

## Gap vs vision

Vision: *a campaign brief plus podcast footage goes in; the factory edits, clips, posts,
experiments and re-edits around the goal and the brand.* Moment choice and grounding are
already strong. The largest gaps are in turning the brief into output and in editing
craft. Effort uses S/M/L. Every upgrade assumes a 16 GB M5, local models only, FFmpeg 4.4
with libass and drawtext, and no Homebrew.

| # | Upgrade | Impact | Effort | Extends | 16 GB / local risk |
| --- | --- | --- | --- | --- | --- |
| 1 | **Brief-driven agents**: give each role explicit instructions that use `brief_snapshot` (audience, constraints, requested_outputs) and score fit to the brief | High | S | `team.py:_agent` instructions, `scouts.py:CRITERIA`, `_swarm` prompt | Prompt size versus a 4B model's 8K context. Keep the brief block to about 1,000 characters. |
| 2 | **Per-run direction note** (finish what is in flight) | High | S | `campaigns.py:AgentProduction` → `TeamEngine.create` context | Prompt-injection surface. Keep it inside the "untrusted DATA" framing. |
| 3 | **A/B variants per moment**: 2–3 hooks or openings for one range, tagged `changed_variable` | High | M | `_swarm` treatments, `Render.changed_variable`, `parent_clip_id` | Each variant is another render (about 2× disk and time). Render variants serially. |
| 4 | **Silence / filler jump cuts** using word timestamps | High | M | Generalize `render` segments beyond cold_open and main, `caption_entries` offsets | Many-segment concat graphs in FFmpeg 4.4. Caption re-timing must stay verified by `verify`. |
| 5 | **Hook craft**: rewrite hooks into a designed title card for the first 2 s | High | S–M | `.hook.ass` style, critic `claims` check | Rewritten hooks may overclaim, so the critic must still ground them. |
| 6 | **Speaker / face reframing for 9:16** that follows the subject over time | High | L | `media.py:action_window` → per-segment `focus_x` keyframes | No face model is shipped. Options are Apple Vision via Swift or a small detector. CPU cost on long sources. Avoid jitter by holding the frame between cuts. |
| 7 | **Loudness normalization** (`loudnorm` to −14 LUFS) | Medium | S | `render` audio chain, `verify` audio_level | Two-pass loudnorm doubles audio decode time. One pass is fine for clips. |
| 8 | **Emphasis captions**: highlight keywords, configurable font and position | Medium | S–M | `pop_captions`, `Direction.caption_style` (add `pop`) | Keyword picks need an LLM call per clip, or a cheap TF-IDF fallback. |
| 9 | **Brand kit + CTA end card** (logo, colors, font, closing slate) | Medium | M | `Profile` assets, `render` overlay and concat tail | Font files must be bundled because libass falls back to Arial. Logo upload validation. |
| 10 | **Cover frame selection + punch-in on emphasis** | Medium | M | `render_task` cover step and the close-up `peak_frame`, `push` expression | Zoom expressions per keyframe are slow on CPU. Cap them at 2–3 per clip. |

Upgrades 1–2 and 7 are cheap and bring the engine closer to "edits around the brief."
Upgrades 3–6 are what make output look edited rather than just trimmed.
