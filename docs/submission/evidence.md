# Submission evidence and claim boundaries

Refreshed 2026-11-14 from published master `5e6c6a0`, current handoffs and direct
repo/dashboard inspection. This ledger distinguishes source implementation,
automated checks, historical live execution and still-open acceptance gates.

| Area | What the evidence supports | What it does not establish | Source |
| --- | --- | --- | --- |
| Pearl desktop UI | One navigation, focused profile editors, matching Command-K, review/Library/Results surfaces; sample preview visually checked. | A hosted preview cannot render or publish and is not a fresh account acceptance test. | `.sw-factory/pearl-master-merge.md`, `.sw-factory/pearl-studio-plan.md` |
| Builder | One live temporary-clone progress-bar build: 29 s, $0.0535 provider model cost; static checks, 12 generated tests and sample render passed. | No merge/deployment of the extension; no general success rate, end-to-end cost or arbitrary-code safety certification. | [factory-builder.md](../factory-builder.md#verified) |
| Real media | Historical real Whisper/vision calls, source-backed captioned renders, immutable revisions and byte-verified exports. One 90 s source produced a 15.1 s checked draft in 119.2 s. | Human editorial acceptance, current fresh generation or a universal latency/model-quality benchmark. | [demo acceptance](../demo-acceptance.md), [local-model setup](../local-model-setup.md) |
| Engine-quality wave | Historical ten-minute test generated 13 clips; top eight roughly 31–36 s with captions/hook-first. | A ranking score cannot certify semantic accuracy. A later in-progress audit found a hook negation/meaning issue; fresh regression and human review remain gates. | [handoff](../HANDOFF.md), current uncommitted engine evaluation (not a published artifact) |
| Instagram accounts | Separate historical provider readbacks verified account/media/insight paths. | Successful first publication through the current app or proof of remote media bytes matching a local file. | [Instagram connection](../instagram-connect.md), [Composio setup](../composio-setup.md) |
| Publishing | Implemented human-approved Composio/Supabase path, pre-post gate, package controls, schedules and durable unknown-outcome reconciliation. | First real app post still pending; no unattended closed-laptop publication claim. | [publishing](../instagram-publishing.md), [handoff](../HANDOFF.md) |
| Learning / Strategist | Committed observations/one-variable proposals, policy memory, confidence accounting and labeled simulation. | Weight training, measured growth, causal organic lift or completion of the current account's full live loop. | [learning loop](../learning-loop.md), [Strategist](../strategist.md) |
| Auth/storage | Supabase sign-in and publishing storage exist; SQLite remains operational state. | General cloud state sync, multi-user workspace sharing or always-on hosted workers. | [cloud state](../cloud-state.md), [handoff](../HANDOFF.md) |
| New scoring/demo wave | Active checkout contains creative scoring, preference/re-cut and richer rehearsal work. | Not included in published `5e6c6a0`. Promote only after exact reviewed commits and tests land. | Active worktree / current coordinator handoff |

## Automated verification

- UI integration at `5e6c6a0`: 145 targeted frontend tests, one backend source-deletion regression, TypeScript/Vite build and diff checks passed locally.
- Full hosted run [43633068048](https://github.com/MaxtheN/theclipfactory/actions/runs/43633068048) failed on Vitest five-second timeouts in workspace/onboarding suites. Backend/build steps were not reached. Earlier Pearl revision had the same timeout class.
- This preparation pass caps Vitest at two workers. On the clean merged tree, **all 421 frontend tests across 42 files passed in 36.06 seconds**, followed by TypeScript/Vite build. No timeout increases, retries or weakened assertions were used.
- Hosted run [43634037706](https://github.com/MaxtheN/theclipfactory/actions/runs/43634037706) on the worker-cap commit still hit five-second limits in the two full-app journey files. A follow-up gives only those integration files a bounded 15-second test budget; unit files keep the default five seconds, and Vitest resets per-file configuration. No retries or assertion changes were added. The scoped pair passed 25/25 and the full suite passed **421/421 in 34.62 seconds** locally.
- The next hosted run must be checked separately: [GitHub Actions](https://github.com/MaxtheN/theclipfactory/actions). Local success does not imply hosted success or real media/provider acceptance.

## Pre-event declaration

The founder confirmed that no project code, prototype, designs or templates existed
before EVOLVE. The first repository commit is dated 2026-11-13. This is a team
statement plus repository chronology, not an independent authorship investigation.
Third-party dependencies, pretrained weights, services and development tools remain
separately attributed.

## Recording labels

Use `REAL RENDER`, `PREPARED HISTORICAL RUN`, `UI PREVIEW — SAMPLE DATA` and
`SIMULATION — SYNTHETIC INSTAGRAM DATA` where applicable. An early real measurement
retains its `demo_override` badge and actual elapsed time. A simulated later plan is
not a rendered revised clip. Never present test doubles as live service calls.
