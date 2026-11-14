# Independent media/scout review

## Round 1 — 2026-11-14

**Reviewer:** merged_workflow_audit (not the implementer of these six files). **Verdict: APPROVED. No blocking findings.**

## Scope

Reviewed the current checkout against `origin/master` **7e5d880a871a678307ea54b1c1e8c1f75202aca3**, including working-tree changes rather than relying on committed paths alone:

- `clip_factory/scouts.py`
- `clip_factory/evidence.py`
- `clip_factory/team.py`
- `tests/test_scouts.py`
- `tests/test_evidence.py`
- `tests/test_team.py`

The six-file delta is 244 insertions / 33 deletions. Inspected the existing Models `release_warm` cleanup contract and downstream editor/critic/recheck evidence consumers for compatibility. This review does not cover concurrent account/API/UI changes or certify local model performance. The review delegate separately authored learning.py; that module is not independently approved by this report.

## Review dimensions

**Requirements alignment.** Invalid scout ranges are now rejected, preserving original copy/range correspondence instead of shortening or clamping a model proposal and retaining stale hook/caption metadata. Nested/non-integer selector values are discarded before deduplication, preventing untrusted lists/dicts/bools from crashing a valid scout pass. The selected-speech stage supplies the actual late source cues to editing, critique and recheck; a discovery excerpt is no longer presented as the complete speech for a chosen moment. Human acceptance remains separate from model critique and output drafts remain unapproved.

**Blueprint alignment.** Existing bounded source analysis, source-grounding validation, task ledger and deterministic rendering remain the architecture. Selected transcript bundles preserve original cue index, timestamps, text and video identity. Source reference validation checks overlap with actual bundled cue intervals, so a bundle's broad min/max range cannot ground silence between distant cues. Oversize selected evidence fails explicitly before downstream editing/rendering rather than truncating words or silently falling back to approximate discovery evidence. This does not assert word-level semantic accuracy or prove audience performance.

**Architecture and conventions.** The pure selected_transcript helper contains no provider/file/network operations. Team orchestration records a source_evidence tool task and preserves discovery references separately for audit. Selected bundles are attached before downstream role calls; editor evidence is scoped to accepted moments and critic/recheck read the persisted exact evidence. The existing 16-reference limit is respected by grouping original timed cues into bounded per-moment bundles. Scout warm-model cleanup uses finally across success, no valid moments and cancellation; the production Models.release_warm handles Ollama cleanup errors without substituting another model or changing review state. No new service, framework, publication or retry loop is introduced by these changes.

**Tests and build health.** Independently ran:

`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/Users/kartikbihani/WIN/growth-factory-integration /Users/kartikbihani/WIN/theclipfactory/.venv/bin/python -m pytest tests/test_scouts.py tests/test_evidence.py tests/test_team.py -q`

Result: **108 passed in 0.84 seconds**, no failures/skips/warnings. Ran Ruff on all six reviewed files: **all checks passed**. Ran git diff --check on the same paths: **passed**. Tests use injected/scripted model and worker harnesses; no real model download/inference, heavyweight media job, active smoke instance, provider request, publication or paid action was run. Relevant regressions exercise nested selectors, unchanged rejected ranges, late exact speech preservation through editor/critic/recheck, silence gaps, oversize evidence failure before render, and warm-model release on success/failure/cancellation.

**User-facing verification.** This change is backend source-evidence correctness, not a layout change; prior desktop/browser UI review is not reused as evidence of actual model quality. Verified test/readback shows persisted source_evidence task inputs/outputs and failed tasks remain inspectable, exact speech remains available for a later critique recheck, and no failing evidence stage claims a completed render. Root/runtime ownership retains the separate requirement to inspect genuine produced clips on the target Mac.

**Security, privacy and data safety.** Model selector/range output remains untrusted and bounds checked. No original transcript cues are rewritten into invented speech. The added full selected speech remains local evidence within the existing explicit model/runtime path; no credential storage, new remote route, social authorization or paid spending is added. Cancellation still terminates work, and cleanup does not invoke dependent renders. Existing cue/range validation and approved campaign scope remain authoritative.

## Limits and handoff

Approval covers these six media/scout corrections only. Full runtime/native/actual-artifact evidence and the separately reviewed learning/account integration remain owner gates. Discovery continues to use bounded excerpts to explore a long source; complete selected cues improve the subsequent grounded review but cannot establish that a hook is factual, compelling or causally improves growth without further review/evidence.
