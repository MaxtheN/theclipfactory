# Review Log: WO-3

## Round 1 — independent code review

Reviewer: dedicated interface review delegate. Baseline: master bfa9589; reviewed working tree on kartik/growth-factory-interface, including tracked changes and new growth/ source, tests, architecture notes and execution records. Product files were not changed by this reviewer.

### Requirements and blueprint alignment

The interface-first scope follows the four-stage campaign workspace and retains existing native authentication, service contracts and approval boundaries. Missing reference-inspection and statistical evaluation APIs are exposed as integration limits rather than claimed implementations. Results blueprint remains a template. Full render/research/measurement acceptance is outside the interface-only proof and must not be reported complete.

**Blocking — Studio.tsx / Results.tsx, user-facing behavior:** approving a next test passes preferredSource to Studio, but an existing selected clip keeps the inspector in old-output review mode. Request a change resets sourceId to the old clip source. The ordinary learning loop therefore cannot start the second-source render. Open an explicit fresh-production form on next-test handoff and provide a new-cut/variant action while preserving earlier outputs.

**Blocking — Research.tsx, requirements alignment:** canApprove compares only Direction. Editing only the supplied reference or rationale leaves approval enabled and activates the old saved content without persisting the visible edits. Include all approval-relevant fields in dirty detection and require saving changed input before approval.

**Blocking — Results.tsx, requirements alignment:** pending selection accepts any proposed strategy at the current base/profile, including creative Research drafts; primary approves it even if the user changed the visible rule/hypothesis. Restrict this surface to a saved evidence-linked learning proposal and ensure approval matches the persisted content shown to the user.

### Architecture and conventions

A focused typed service facade, unchanged loopback API and compile-time-only fixture transport are appropriate. Vite single-file native packaging is preserved. No README changes. Advisory: operational-tools navigation unmounts step components and loses unsaved local drafts; preserving drafts through this recovery path would improve the UX. Advisory: response list guards currently check IDs only, weaker than the existing Campaigns domain validation.

### Tests and build health

Independently ran frontend npm test: 9 files, 145 tests passed. Independently ran npm run build: TypeScript and single-file Vite production build passed. Existing tests do not cover the three blocking user journeys above. Root reported backend/launcher suite 509 passed, 12 skipped and an actual native authenticated-window smoke; these were not independently rerun by this reviewer.

### User-facing verification

Root owns browser/desktop exploratory verification and screenshots. This delegate inspected component state transitions and API calls. Advisory: narrow-layout navigation hides stage labels without supplying explicit aria-labels; add stable accessible stage names.

### Security, privacy and data safety

No new remote origin, credential exposure, CORS relaxation, arbitrary HTML insertion or live social action was found. Hosted fixture code remains behind an explicit build flag, with conspicuous sample labels. Export is guarded by exact clip approval, current state and team critique. Preview export never provides a media response. Native service failures do not switch to fixture data.

### Verdict

**CHANGES_REQUESTED** — three blocking flow/approval findings. Fix them and rerun a full review with targeted regression tests before final handoff. The underlying architecture is suitable for the requested UI-first iteration.


## Round 2 — independent re-review after fixes

### Findings resolved

- Studio now has an explicit fresh-production state and a New cut action. The next-test source/version handoff opens the production form on source B without discarding source A output. Incoming output IDs select the completed new clip for fresh review.
- Research compares the exact saved rationale/reference string as well as the editable direction. Reference-only edits now require saving another draft before approval.
- Results filters current-base proposed versions to evidence-linked hypotheses, compares visible rule/hypothesis to persisted content, and returns to draft save when either differs.
- An additional cross-campaign risk found during re-review is fixed: New campaign disables non-Setup navigation until saved and clears the old completion/strategy context. It no longer presents old-campaign operations under the new-campaign header.
- Operational tools preserve the mounted hidden main workspace, retaining drafts on return. Stage navigation now has explicit accessible labels in narrow layouts.

### Requirements and blueprint alignment

The implemented four-stage interface and native adapter match the interface-first scope authorized by the user. Approval remains separate from production and critique; account scope and strategy lineage are retained. The hosted review intentionally proves only the interface. Missing reference inspection, statistical evaluation and target-machine model/render quality remain documented integration work, not passed acceptance claims.

### Architecture and security

Rechecked the root shell, typed service, native bootstrap/title change, preview transport, source import, clip review/export and strategy/observation handoffs. No credential handling, external side effect, CORS relaxation or automatic native-to-preview fallback was introduced. Existing README files remain unchanged. Advisory: checkedList validates IDs but does not yet validate complete domain response shapes; fuller guards would provide better recovery from malformed service responses.

### Verification

Independently reran npm test after fixes: 9 files / 148 tests passed. New regressions cover reference-only draft persistence, exact pending-rule approval, second-source fresh production and unsaved-new-campaign scope. Independently reran npm run build: TypeScript and Vite single-file build passed (342.09 kB normal native HTML). Root owns current browser layout/flow evidence and native smoke/package verification.

### Final review verdict

**APPROVED** for the interface-first change. Zero remaining blocking code findings; one advisory on response shape validation. Approval does not certify real model quality, video rendering, live analytics, publishing, signed distribution or the complete Growth Factory product requirements.


## Round 3 — native live-development viewer

### Scope and architecture

Reviewed scripts/preview-interface.py, the dev:review and desktop:review package commands, and the native-versus-bundled delivery notes in docs/interface-architecture.md. The new helper opens the existing local Vite interface in pywebview; it does not change the packaged app's server, authentication, data directory or media/model runtime. dev:review explicitly enables fixture mode and binds Vite to loopback on a strict port. The normal production build command remains unchanged.

### Validation and safety

The helper rejects non-loopback hosts, HTTPS/external URLs, embedded credentials and query/fragment parameters, checks the interface response before opening the window, and reports a recovery command when the server is unavailable. It does not accept a native bootstrap token or expose the production service. Documentation correctly distinguishes live Vite updates from a rebuilt bundled app. No README files changed.

Independently ran Ruff on the helper: passed. Independently exercised four rejected URL cases (external HTTPS, external HTTP, loopback URL containing a bootstrap query, and embedded credentials): all exited with argparse validation errors before a viewer opened. Root reported a real loaded native window and saved 1440x960 window screenshot; the reviewer did not open a second competing window.

### Verdict

**APPROVED** — zero blocking findings for this bounded development helper. This is live interface preview evidence, not a claim of model execution, rendering or signed distribution.
