# Learning loop: evidence to a real next draft

## Durable contract

Approved local clip + explicit connected account + provider media ID/time + user-confirmed clip mapping → saved publication →3/6-day due work → immutable cumulative metrics → bounded analyst → one experiment → actual unapproved render → verified receipt → human review.

SQLite remains the runtime store. Each record links campaign/profile/account/source/clip/base/snapshot/experiment/job identifiers. Published strategy remains unchanged until explicit human promotion. This is policy and experiment memory, not model-weight training.

## API and UI

- Results / Connect an Instagram account: Keychain-backed settings, managed OAuth links, verified completion or exact existing-account import.
- /api/automation/policies: exact campaign/profile/account policy,3/6days, allowed hook/duration fields, auto drafts, pause.
- /api/automation/publications: exact approved clip hash and user mapping confirmation; server checks media ownership and obtains publication time from provider.
- /api/automation/state: saved publications, snapshots, work and experiments; /check requests only due work, never advances the clock.
- Local worker runs while app is open and catches up after reopening. Provider/model reads retry at most3times with bounded backoff. Invalid model handoffs receive at most one correction per analyst job; cancellation and failed validation do not become fabricated decisions.

## Evidence and edits

Snapshots preserve unknown values and provenance. Cumulative counts are never summed; unchanged cumulative evidence is not repeatedly treated as new information. No goal/comparison/attribution means no overall winner or causal-lift claim. An experiment can be exploratory and must disclose limitations.

A hook experiment changes rendered text; duration changes require recorded transcript boundaries. Every request preserves parent source/profile/base and unrelated physical edit settings. Older optional opening metadata is resolved only from explicit saved render facts; raw parent plan and normalization notes remain in the receipt. Missing or contradictory proof is held for review.

The renderer receives a frozen real Production request and tags its job/output with experiment_id. Unknown submissions are reconciled against exactly one scoped saved job; zero/multiple matches remain held. Exact job/result/hash/plan/lineage checks determine production completion. Outputs start unapproved; a later recorded human approval remains distinguishable from that initial state.

## Closing the loop: memory → next production → proposed rule

The loop now feeds forward instead of ending at one draft:

1. **Learning memory** (`learning.memory_digest`). A pure, deterministic, size-bounded read of saved records for one profile (optionally one account/campaign): the latest experiments (variable, before → after, status, trigger, whether the variant was measured), a per-metric account **baseline** = median across tracked posts' *latest* cumulative snapshot (null when unknown, never zero; real zeros stay zeros), and, only when an experiment's own draft was later published, tracked and measured, a **variant-vs-parent comparison** labelled `observational`. Every entry carries its experiment/snapshot IDs. Captions and model rationales are omitted; hooks are truncated data. Oversized memory drops the oldest detail first (`bound_digest`).
2. **Analyst.** The engine passes the digest to the analyst as `learning_memory`. It is optional context: it is shrunk deterministically to keep the prompt inside the existing 8192-token budget (with room for the single repair turn) and omitted rather than overflow. Citations must still be the exact current snapshot.
3. **Next production.** Team runs started from a campaign snapshot save a 2,000-character digest in `context.learning_memory`. The producer brief carries it; its experiments/comparisons become citable `experiment:<id>` / `comparison:<id>` evidence for the performance analyst (which therefore runs when memory exists); swarm scene prompts carry a 1,200-character copy. Previous-observation clips are now the 8 most recent by `created_at`.
4. **Proposed editing rule.** When an experiment's draft is verified complete, `Campaigns.propose_from_experiment` saves a `status: "proposed"` strategy version with `source: "learning_experiment"` (allowed sources: `manual`, `learning_experiment`) and a `learning` block: experiment ID, variable, before/after, snapshot IDs, trigger, real elapsed hours and the observational caveat. It rebases on the experiment's own approved base, so a stale base is refused and recorded on the experiment as `strategy_proposal.status: "not_proposed"` without undoing the draft. It is never approved automatically; the existing approve guards (stale parent, profile coverage) still apply in Editing rules.
5. **Results UI.** "What we've learned" shows the baseline, experiments, observational comparisons and any proposed rule waiting for approval, with a link to Editing rules (`GET /api/automation/memory`).

Lease safety: the analyst waits at most `ANALYST_TIMEOUT_SECONDS` (600 s); a claim lease is that plus 10 minutes, so a running analysis is never re-claimed.

## Demo trigger: measure now

`POST /api/automation/publications/{id}/measure-now` (authenticated like every local API; Results shows **Measure now (demo — window not elapsed)**) moves only that one human-mapped publication's due time to now. It is refused for unknown or unmapped publications, archived channels, paused policies, stale bases and posts with work in progress; if the window already elapsed it reports `already_due` and labels nothing. The collector still makes a real provider read as of the real clock; no window or clock is faked. The work, its new snapshot, the experiment and any proposed rule record `trigger: "demo_override"` and `real_elapsed_hours`, and the UI shows a badge on each. After the work finishes, the regular 3/6-day schedule resumes and the real scheduled check still runs.

## What is real, demo-override, and unproven

- Real and offline-tested: digest, analyst/team context, proposal creation and guards, measure-now labelling, UI panel/button/badges.
- Demo-override: a measurement taken before the cadence window; its metrics are real but early, and are labelled as such everywhere.
- Unproven: a clean fresh live analyst run with learning memory on the current code; publishing through Composio (still read-only here); any causal audience improvement from an accepted rule.

## Autonomy policy

Automatic drafts; human approval for each publication; no paid spending. Saving an experiment never promotes global strategy or grants permission to post. Composio is currently a read-only integration boundary. Public hosting and a complete approved-publication/reconciliation flow are separate implementation gates.

## Actual model qualification

The1.7Btext model installed and fit memory but failed handoff/no-op validation in real tests.4Bwithold16Kcontext reached critical memory; the test stopped.8Kper-request context plus projected timed cues produced a valid4Bproposal and actual recovered FFmpeg variant. Prior failures and synthetic input labels remain preserved outsideGit in research/growth-factory/integration/learning-loop-smoke. A fresh all-current-code rehearsal is tracked there separately. Production proof is not audience improvement.

## Cloud boundary

Supabase's3owner-private tables and7RLS policies were applied/tested; Mac state still remains local. Before sync: actual Auth session, safe metadata projection excluding credentials/local paths/raw logs, version conflict protocol and explicit team access. No service-role key belongs in the desktop app. Always-on collection requires a separately deployed worker.
