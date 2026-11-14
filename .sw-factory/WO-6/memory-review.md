# Independent local-context memory review

## Round 1 — 2026-11-14

**Reviewer:** merged_workflow_audit. **Verdict: APPROVED**, after the explicit-MLX-cap blocker was fixed by the implementation owner. This approves the scoped request/adapter safeguards, not a measured target-Mac memory footprint or successful pending model run.

### Scope and finding resolution

Reviewed current `Models.run` → `_run_ollama` → `Ollama.generate` changes and `AutonomyRuntime.analyze`, plus the unchanged standalone inference-worker input contract. Reviewer only added tests in `tests/test_ollama.py` and this report; no product files were edited.

Initially, a supplied `context_tokens=8192` was validated but silently omitted on the MLX path, which would have implied a cap that the worker never applied. Reported this immediately. Owner added a guard rejecting explicit caps for non-Ollama or non-generate calls before model requirement/spawn; readback and regression now pass. Default MLX generation remains supported without a claimed explicit cap.

### Review dimensions

- **Requirements / blueprint:** learning explicitly requests 8,192 context tokens with a 1,500-token output budget, independently of the existing vision path. Complete selected timed cues retain start/end/text; large word-level arrays, token lists and probability metadata are excluded rather than serialized into the prompt. Snapshot, policy/account scope and source identity remain in valid compact JSON. Oversize input fails before enqueue/inference rather than silently truncating evidence.
- **Architecture / conventions:** the context setting is a named runtime argument, not a new standalone worker payload field. Supported integer range is 2,048–16,384; booleans, strings, floats, NaN and out-of-range numbers fail closed. Only an explicit value produces `options.num_ctx` in actual Ollama chat JSON; `None` leaves the existing vision/default behavior unchanged. Cleanup/warm-model behavior is unaffected.
- **Tests / build health:** independently ran `pytest tests/test_ollama.py -q`: **52 passed in 0.16 seconds**. Ruff for the owned test file: **all checks passed**. Tests use `httpx.MockTransport`, fake synchronous jobs and fake models: no network, model, download, app lifespan or inference worker is started. Coverage verifies the actual outbound JSON for 2K/8K/16K, defaults with images, invalid caps, fail-closed unsupported MLX/transcription caps, unchanged default MLX request keys, cue-only projection of large metadata, preserved snapshot/context and ASCII/multibyte overflow rejection before job/model call.
- **User-visible behavior:** an oversized learning request reports a local-context failure and creates no analysis job; unsupported explicit MLX limits report an error instead of pretending to use an 8K cap. This has no layout change requiring another browser/native session. Actual successful local-agent output and memory usage remain runtime/proof-owner checks.
- **Security / data safety:** no provider fallback, new remote endpoint or permissions added. Source speech is not changed or partially serialized to hide missing evidence. Invalid settings cannot reach inference. Tests never use user media, credentials or the active smoke database.

### Advisory and limits

The UTF-8 byte count plus output budget is conservative for the intended text prompt, but it does not include tokenizer-specific chat-template/special-token overhead. Reserve a small explicit template margin or use an exact tokenizer before calling it a rigorous total-token bound. The real `num_ctx=8192` request still bounds the Ollama allocation; this advisory concerns the stronger claim that no input truncation is mathematically possible at the exact boundary.

Explicit context limiting currently supports Ollama text generation only. Do not advertise the same limit for MLX or infer memory demand from model download size. No claim about the smaller model's real quality, peak RAM, KV cache size or completed installation is established by these offline tests.

## Round 2 — bounded learning-handoff repair

**Verdict: APPROVED for the scoped protocol safeguards.** No new blocking finding. Reviewed current runtime changes without editing product code; appended fake-role tests only in the assigned `tests/test_ollama.py`.

The runtime now shares the domain AnalysisResult schema, so a hook/duration proposal cannot validate with both edit fields populated. An experiment must cite the exact current snapshot and must change the existing hook/duration before the analysis job can complete. One validation correction is permitted: at most two model invocations in one analysis job. Both calls use the original untrusted-data prompt; repair adds bounded static protocol guidance and a safe validation reason, not the previous raw model output. No fabricated insufficient-evidence fallback replaces a second invalid answer.

The job persists actual agent_attempts and validation_failures. Cancellation is checked before each invocation; model/runtime failures are not disguised as validation repairs. Initial and repaired prompts are checked against the 8K setting, 1,500-output reserve and newly added **256-token template margin**. The prior template-margin advisory is addressed conservatively; this remains a byte-budget guard rather than a tokenizer/memory benchmark.

**Independent verification:** `pytest tests/test_ollama.py -q` → **58 passed in 0.21 seconds**; Ruff on owned tests → **all checks passed**. Fake synchronous jobs persist failed/cancelled/completed outcomes using the temporary Store and fake model responses; no real inference, network, app lifespan or active proof database is involved. New tests verify:

- Mutually exclusive field violation → one valid changed-hook correction.
- Foreign experiment citation → exact-snapshot correction.
- No-op hook (including surrounding whitespace) → genuinely model-returned insufficient evidence.
- Two invalid answers → failed job, exactly two model calls, two recorded failures and no invented result.
- Cancellation before correction → cancelled job and exactly one model call.
- Repair that would exceed budget → failed job before a second inference; agent_attempts stays truthful at one.

**Remaining advisory:** current runtime validates citation identity within the experiment branch. An insufficient-evidence response containing foreign evidence IDs is still rejected by the domain after the analysis job, rather than repaired inside that job. Moving a subset-of-current-snapshot citation check before the status branch would make job-level validation more consistent. The domain remains fail-closed, so this does not authorize a draft. Also, explicitly state unused edit fields must be null in the initial prompt as well as the repair to reduce avoidable first-pass failures.

All broader boundaries remain unchanged: exact account/source/base checks and actual draft production are domain/renderer responsibilities; successful fake-role tests do not prove the smaller local model produces useful editorial changes. Actual proof attempt and machine-memory observations remain with the runtime owner.
