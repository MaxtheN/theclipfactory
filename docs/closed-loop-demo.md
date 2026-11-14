# Growth Factory: judge rehearsal and first real post

## What the demo proves

Show a connected marketing workflow: source-backed production, inspectable quality rubric, human review, one editorial experiment, actual draft rendering, and traceable outcomes. A finished render is not publication approval. A quality score or synthetic engagement result is not measured growth. “10×” needs a matched manual benchmark, elapsed time, active human minutes and acceptance counts before it is a claim.

## Fresh generation first

The read-only audit on November 14 found the fresh-test-2 account still had the earlier 13 unapproved, uncaptioned clips and no transcript on its 10-minute source. Ignore those old clips. After updating the app, generate a fresh batch, confirm the speech setup succeeds, and inspect actual captions/audio/source fidelity. The current engine retains negation when it shortens a hook or teaser; the prior 72-point pillow-talk hook had reversed the source meaning and must not be used as evidence of quality. See engine-eval.md.

### Speech runtime repair, November 14

The existing runtime contained PyTorch 2.15.0 package metadata but was missing `torch/lib/libtorch_cpu.dylib`. Reinstalling that same wheel with `--force-reinstall --no-deps` restored the library without downloading Whisper again. Direct `import torch`, the full runtime probe, ASR-only readiness and `speech.check` all pass against fresh-test-2. Speech readiness now probes the Whisper/MLX dependencies independently of optional vision/narration imports; separate caches prevent an optional package failure from incorrectly blocking speech. This verifies readiness, not a fresh transcription or generated clip.

The first real packaged generation attempt subsequently failed the local speech memory guard: about 4.3 GB available versus 5 GB required. Kartik explicitly requested cloud processing instead. Groq Whisper now provides separately opted-in, timestamped speech while OpenRouter handles the text/vision agents. Local speech remains the default for other users. Queued jobs retain their admitted provider; disabling cloud speech stops further upload work rather than silently changing routes. Actual audio billing is unknown; any displayed price is an estimate, separately recorded from OpenRouter costs.

The failed attempt exposed an existing destructive replacement policy: it deleted the 13 earlier drafts before attempting transcription. Generation admission no longer deletes existing outputs, including outputs from other campaigns sharing a video. Explicit Remove is unchanged. The source survives, and the old metadata remains in the before-rerun SQLite backup; the old 13 MP4 files have not been recovered. Do not describe them as preserved in Library. See the external `closed-loop-proof/legacy-recovery/manifest.json` audit.

## Three distinct scores/evidence sources

1. Production rubric: eight weighted signals totaling100 — strength25%, payoff15%, completeness15%, brief fit15%, scene interest10%, technical10%, critic5%, hook5%. Unknown inputs are identified; neutral/proxy defaults are visible. This rubric is not an engagement forecast.
2. AI editorial judge: separate0–5 ratings for source faithfulness, hook clarity, context, payoff and brand fit, with exact quotations or unknown. Text-only: it does not claim to watch the rendered frames or hear audio. Configured cloud clip-agent consent is required; one repair maximum, separate per-call cost, exact file/context/model/rubric cache. A changed or missing file makes a cached judgment noncurrent.
3. Human taste and Instagram observations: reviews teach scoped preference alignment only after enough positive/negative examples. Instagram metrics retain account/media/window provenance. Neither type silently replaces the other.

The actual isolated Haiku check found the bad negation hook, scored source faithfulness2/5 and proposed preserving the negation. One call cost$0.000598. Its55/100 AI editorial score and the old72 production score use different rubrics; do not describe that difference as improvement.

## Live walkthrough: one button, about 25 seconds

Results has the one **▶ Run the learning loop** button (the Factory map shows live state only).
The demo plays inside the Results pane (sidebar and top bar stay) across all stations:
Footage → Listen/Watch → Scouts → Brief/Editor → Critic (top 3 real clips) → Approve/Post
(simulated) → Measure (3-second-hold race vs your typical, SIMULATED, deterministic) →
Strategist (production `evaluate_belief` over those simulated observations, in memory) →
Style rules → Editor re-edit. Story: the winner's real opening is a question or punchline;
the underperformer's opens on setup. Beliefs: "Question hooks hold viewers" (+N% 3-sec hold)
and "Tighter pacing wins" (shown as the next test when these clips do not test it). The
re-edit is a **real, unapproved** render of the underperformer changing the hook: it opens on
a question (or negation punchline) sentence spoken in that clip (`structure=hook_first` with
that payoff span) under a ≤8-word title card of the same source words. Jump cuts are not a
supported single-variable experiment, so they are queued as "Next test: jump cuts".
Next / Pause / Skip to re-edit / Close (Esc); reduced motion is static.

After a run, Results shows the simulated outcome (3 posted clips vs baseline, beliefs, the
"Hook: setup → question" before/after) from a per-brand browser demo store that never mixes
with account history; "Reset demo" clears it.

Honesty: one "Simulated" pill; nothing posts; no synthetic metric is stored; the draft is
unapproved. Code: `clip_factory/learning_demo.py`, `POST /api/demo-loop/{profile}/learning-loop`
(+ `/recut`, `GET /api/demo-loop/loops/{id}`), `GrowthLoop.demo_recut`,
`frontend/src/growth/LearningLoopDemo.tsx`, `demoStore.ts`, `FactoryStage` in `FactoryMap.tsx`.
The recut request id is stable per clip/payoff, so a replay reuses the existing draft.

## Real production controls

Automatic A/B is opt-in per brand. It retains the original as A and renders one B per top-three group changing only hook presentation. Requests are durable and idempotent; source jobs dispatch serially. Held/unknown submissions require reconciliation and are not blindly rerun.

“Apply approved rule → re-cut” uses the active approved version and accepts exactly one supported rule change relative to the parent. Each actual new output is unapproved. Loop receipts expose what changed, why, source versions, jobs and outputs. Real observation readouts await exact publication mappings and sufficient matched windows; raw metrics remain visible when comparison is withheld.

## First real post to @kartik._builds

1. Generate and inspect the fresh current-engine batch.
2. Select the exact video revision; preview its cover and final caption together and show them to Kartik.
3. Obtain approval of that exact clip/caption before the external publication action.
4. Verify the selected connected account is @kartik._builds, then use the reviewed Approve & post flow. Sign-in/account import is setup, not content approval.
5. Preserve provider attempt/media IDs. If the outcome is unknown, Check status; never click another blind publish attempt.
6. The confirmed publication starts a real3/6-day measurement window. App-open collection and any early measurement/demo override remain visibly labelled. No accelerated animation can replace those real days.

No real post was made during implementation. The finished rehearsal belongs in the Mac app; the standalone prototype is not the judge-facing demo. Website changes remain unpublished pending review. Product, Learning and Mac setup/availability pages accompany the homepage.

## Final integration verification

Local baseline fast-forwarded safely to master5ed8e03 (includes Pearl Studio and the reviewed Library/source cleanup); all in-progress changes were backed up and reapplied without conflicts. Focused final checks:100 backend tests across10 files,24 frontend interaction tests across the growth-loop/Results and onboarding files, TypeScript, Ruff and whitespace checks. Independent code review approved. The real FFmpeg proof covers parent→A/B→approved-rule recut→rubric-guided rehearsal: four distinct artifacts, exact single-field differences, retained negation, fresh unapproved outputs, exact parent bytes unchanged and no synthetic metrics in real observation tables.
