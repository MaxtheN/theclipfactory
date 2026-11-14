# Growth Factory: the working learning loop

Upload footage once. Agents find moments and render drafts. A person reviews each publication. The factory collects real post metrics after three or six days, records a bounded experiment, and renders the next unapproved draft.

## What each agent owns

| Agent | Exact input | Exact output |
| --- | --- | --- |
| Creative producer | Source, transcript, audience, approved direction | Grounded candidates and actual rendered drafts, with source timestamps |
| Publishing coordinator | Approved clip hash, explicit account, public media URL, publication approval | Durable attempt and provider post identity; uncertain outcomes stop for reconciliation |
| Performance collector | Account, post identity, publication time, due window | Immutable metric snapshot with collection time and unknowns preserved |
| Learning analyst | Snapshot, goal, original edit, approved strategy | One proposed hook or duration change, rationale, evidence IDs and limitations |
| Experiment producer | Valid proposal, original source, parent clip, unchanged approved base | Actual unapproved variant plus job/clip receipt and lineage |

## Execution boundaries

- Automatic drafts; human approval for every publication. No paid activation or spending.
- Account selection is explicit. Never infer an account from the most recently connected identity.
- Existing approved strategy stays active. A learning is an experiment proposal until a person promotes it.
- First automatic edit: change the opening text or duration, one variable at a time. Other creative changes remain proposals.
- Insufficient evidence means an exploratory test or a wait, never a fabricated winner or growth claim.
- Cumulative platform snapshots are not summed. Metrics from different accounts/windows stay separate.
- SQLite stores policy, due work, evidence, proposals and receipts. Credentials belong in macOS Keychain.
- Local scheduling runs while the app is open; overdue work is recovered when it reopens. Always-on operation requires a later hosted worker.

## Demo proof

1. Render a real source-backed clip; review the video and captions.
2. Show explicit account identity and publication approval; do not post without that approval.
3. Import or collect traceable real metrics. Label fixtures used for scheduler tests.
4. Run the analyst: show the exact evidence, proposed single change and its limits.
5. Render that changed draft; show parent, proposal, output hash and unapproved status.
6. Restart a test instance and show saved policy/evidence/receipt without duplicate work.

Production value: elapsed time, human intervention minutes, cost per accepted asset and reviewer acceptance. Audience outcomes require actual observation; a critic score is not business growth.

## Team ownership

- Kartik: interface, account integration, persistent learning and experiment execution.
- Nur: workflow coordination and saved state; integrate through explicit contracts.
- James: transcription, scouting, clipping and media correctness.

## Required later

- Public HTTPS asset hosting, production OAuth configuration and per-account grants.
- Always-on scheduler and operational monitoring; cloud schema is prepared but app Auth/sync/worker deployment remain separate.
- Controlled creative comparisons, attribution and conversion measurement.
- Paid experiment proposals before any separately approved ad execution.
- Notarized Mac release and single-instance hardening.
