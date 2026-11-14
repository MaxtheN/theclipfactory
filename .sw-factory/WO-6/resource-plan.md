# WO-6 resource preflight subplan

## Summary
Add a conservative, fail-closed local model memory preflight. This disjoint subtask supports WO-6's local analyst seam without changing the learning engine, runtime wiring, model settings, approval policy or shared execution records. Runtime integration and the overall work-order checklist/status remain owned by the integrating chat.

## Context and reuse
Read WO-6, its Campaign Workspace and Results requirements, Campaign Workspace, Clip Production, Results, and referenced Precedent Research blueprints through Software Factory. Follow existing Python helper/test conventions and reuse the already declared psutil dependency. Existing Ollama discovery exposes exact model file `size` bytes; do not fetch metadata here. File size is an estimate, not runtime memory measurement.

## Components and flow
Create `clip_factory/learning_resources.py`: `check_learning_resources(model_metadata, *, memory_reader, pressure_reader, context_tokens=8192)` returns immutable `ResourceReadiness` with readiness, safe reasons, required/observed available bytes, normalized pressure and bounded context. Accept positive integer `weights_bytes` or Ollama `size`; hold on unknown/invalid metadata. Require max(6 GiB, weights + 3 GiB). Reject invalid telemetry, unknown/warning/critical pressure, and context outside 2048–8192. Default readers use psutil and the read-only macOS pressure sysctl with a short timeout. No inference, download, network, persistence, credentials, app termination, or fallback models.

## Steps
- [x] Read skill, execution/review guidance, WO-6 plan and linked architecture; inspect analogous code.
- [x] Define contract before implementation and send it to the integration owner.
- [x] Implement helper and user-facing resource policy in the three delegated new files only.
- [x] Run hermetic unit and lint checks with the canonical virtualenv: 80 resource cases pass; combined resource/learning/learning API suite passes 158 cases; targeted ruff passes. One existing Starlette/httpx deprecation warning remains.
- [x] Complete focused independent review; resolve findings and report concrete contract/check evidence.

## Testing
New `tests/test_learning_resources.py` exercises exact budget boundaries, the reported 4.96 GB failure envelope, larger models, unknown and malformed metadata, low/invalid memory, reader errors, pressure values, safe error text, context boundaries and serialization. Mock default readers and subprocess; never inspect live resource state or run a model. Commands: `PYTHONPATH=. /Users/kartikbihani/WIN/theclipfactory/.venv/bin/python -m pytest -q tests/test_learning_resources.py` and the same interpreter's `-m ruff check clip_factory/learning_resources.py tests/test_learning_resources.py`.

## Scope and limits
The 6 GiB floor and 3 GiB reserve are policy estimates motivated by reported pressure failures, not a new successful rehearsal. Passing this helper neither guarantees safe execution nor establishes model quality. Root must recheck immediately before every analysis/repair call and use returned context. No fresh model tests are authorized. Do not commit/push or change README. Overall WO-6 completion is outside this subtask.

## Independent review round 1 — APPROVED
Dedicated reviewer `/root/resource_review` inspected the helper, tests and resource policy against this subplan. No blocking or advisory findings. Requirements and blueprint alignment: conservative local execution gate only; account state, strategy, publication approval and media production remain unchanged. Architecture: standalone read-only helper with injected readers and immutable JSON-compatible result. Tests/build: reviewer independently confirmed 80 resource tests and targeted Ruff pass. User-visible scope: reasons and policy checked; runtime/UI wiring remains with the integration owner, so no browser/manual inference verification applies to this isolated helper. Privacy/safety: telemetry failures and exception text are sanitized; probes are read-only and timeout-bounded; tests use mocks and perform no live probes. Final verdict: **APPROVED**.

## Handoff
Created only this subplan, `clip_factory/learning_resources.py`, `tests/test_learning_resources.py`, and `docs/runtime-resource-policy.md`. Resource contract and verification sent to the integrating chat. No commit, push, shared checklist/status edit, model rehearsal, or runtime wiring performed. Integrator retains overall WO-6 checklist, review log and Software Factory status ownership.
