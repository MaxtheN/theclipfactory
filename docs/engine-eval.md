# Engine evaluation and first-post readiness

Audited November 14, 2026 against the retained run-6 eval.json/result.json and the current fresh-test-2 SQLite store (read-only). This is historical production evidence, not a new generation test or measured marketing improvement.

## Recorded run 6

- Source: the founder's 10-minute All-In excerpt (07:00–17:00), transcript-backed.
- Actual job: 2af20696306a471eba9dd95acc844b19; completed, 13 rendered drafts, no render failures.
- Elapsed 235.5 seconds; 57 provider calls; reported model cost $0.0298. Local compute, electricity and human review are excluded.
- All 13 recorded outputs had burned captions and hook-first structure. Top eight durations 31.467–35.867 seconds; proxy ranking scores 69–72 out of 100.
- Seven human-selected reference IDs appear in the saved above-bar evaluation. This is source-range/reference overlap, not independent editorial acceptance or audience performance.
- The ranking's eight weights are strength 25%, payoff 15%, completeness 15%, brief fit 15%, moment interest 10%, technical 10%, critic 5%, hook 5%. Some inputs are proxies or neutral defaults, not independent model judgments. Swarm critic status was not_applicable.

## Semantic regression found during this audit

One saved payoff says “it's not the type of IP that you're going to convey over pillow talk.” The generated hook omitted the negation and read “You're going to convey over pillow talk”, reversing the claim while scoring 72. The old score therefore cannot certify truthfulness. The source-hook and spoken-teaser shortening now conservatively retain negation; tests cover straight and contracted negation. Prior files remain unchanged and need human review, not retroactive score inflation.

## Current test account

fresh-test-2 still contains the earlier 13 unapproved drafts: zero captioned clips and no source transcript. There are no local publication mappings. API decoration marks those earlier speech-skipped outputs below the bar; raw stored ranks are historical and must not be used as readiness evidence.

Required next: after the design pass finishes, regenerate the source under the current engine; inspect the real rendered video/audio/captions and the rubric; choose the exact clip revision, cover and caption; show them to the founder; publish to @kartik._builds only after that explicit content approval. Posting is not proven until the provider confirms the external media and account identity. Unknown outcomes must be reconciled rather than retried blindly.

## Demo interpretation

Quality score = a documented creative/technical rubric. Taste = the founder's scoped preferences. Simulated Instagram observations = synthetic inputs for a rehearsal. Real platform metrics = actual account/media/window observations. Keep these four evidence types visibly separate. Neither a score rising nor a simulation improving is proof of causal lift or “10× marketing”. A human-effort claim needs a matched baseline and measured intervention time.

The compact prior-run evidence is in .sw-factory/closed-loop-demo/prior-run-audit.json. Temporary raw rehearsal source: engine-runs/6 under the retained Claude scratchpad recorded in docs/HANDOFF.md §6; do not rely on that directory for distribution.

## Actual editorial-judge check after this change

The new assessment path was run once with the configured Haiku model on an isolated copy of the historical negation-broken clip (original account DB and original clip untouched). It returned a valid five-dimension assessment on its first call: source faithfulness 2/5 with exact hook/source quotations, an editorial hold, and a proposed correction preserving the negation. The separate AI editorial score was 55/100; the historical production score was 72/100. These are different rubrics, not a before/after quality improvement. Provider-reported cost was $0.000598 for 1,782 prompt and 840 completion tokens. This was text-only review; no claim of watching frames, hearing audio, new rendering, or Instagram improvement. Compact receipt: .sw-factory/closed-loop-demo/live-assessment-summary.json.
