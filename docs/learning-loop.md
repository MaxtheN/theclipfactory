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

## Autonomy policy

Automatic drafts; human approval for each publication; no paid spending. Saving an experiment never promotes global strategy or grants permission to post. Composio is currently a read-only integration boundary. Public hosting and a complete approved-publication/reconciliation flow are separate implementation gates.

## Actual model qualification

The1.7Btext model installed and fit memory but failed handoff/no-op validation in real tests.4Bwithold16Kcontext reached critical memory; the test stopped.8Kper-request context plus projected timed cues produced a valid4Bproposal and actual recovered FFmpeg variant. Prior failures and synthetic input labels remain preserved outsideGit in research/growth-factory/integration/learning-loop-smoke. A fresh all-current-code rehearsal is tracked there separately. Production proof is not audience improvement.

## Cloud boundary

Supabase's3owner-private tables and7RLS policies were applied/tested; Mac state still remains local. Before sync: actual Auth session, safe metadata projection excluding credentials/local paths/raw logs, version conflict protocol and explicit team access. No service-role key belongs in the desktop app. Always-on collection requires a separately deployed worker.
