# Channel and production flow

## Daily flow

1. Set up the channel once: name, audience, outcome, voice and boundaries.
2. Add footage in Factory. The import surface confirms storage and attachment separately; no guessed upload percentage.
3. Start agent production, or choose a moment manually. The existing team engine transcribes, scouts, plans and renders using the selected source/model and approved editing rules.
4. Review the exact generated clip. Technical checks and version history are available in the inspector. Approve and export that exact revision.
5. Results connects an exact Instagram account and tracks a real post only after the creator confirms its matching approved clip. Three-/six-day measurements inform a bounded next draft; they do not establish causal lift.

## One place for context

Channel settings edits the audience, goal and preferences. It does not require onboarding again or start an agent. Editing rules are a contextual advanced control: save a proposed version, then explicitly approve it. A metadata save never silently replaces approved strategy. Model/tool setup remains in Advanced tools.

## Required controls retained

| Creator action | Existing contract |
|---|---|
| Choose footage | Explicit source ID attached to the current campaign |
| Find moments | Agent production and model selection; actual TeamRun tasks and Jobs |
| Adjust a moment | Manual start/end, source preview and immutable parent revision |
| Control edits | Opening treatment, hook, duration, framing, caption style and subtitles |
| Inspect output | Playable exact file, technical/critic details, versions and checksum |
| Release output | Exact-file review and approval before export/publication |
| Learn | Exact account/post/clip mapping, cumulative metric snapshots and one-variable draft experiments |

User-facing channel language preserves internal campaign/profile/strategy IDs. Earlier clips retain their original context. Local profile records are planning identities; connected Instagram accounts are explicit provider bindings, not inferred from the channel name.

## Cleanup and recovery

Old test campaigns are archived rather than having media/history deleted. Default campaign listing hides them; `GET /api/campaigns?include_archived=true` and `POST /api/campaigns/{id}/restore` provide recovery. Restore keeps learning paused. New edits/production and policy activation reject archived context. Active related work must finish or be canceled before archive. A private SQLite backup precedes actual local cleanup.

## Still required for a public release

Signup/Auth, cloud synchronization and conflict handling, team access, an always-on worker, signed/notarized packaging and single-instance hardening remain separate release work. Supabase's private tables are prepared; this Mac app still uses local SQLite. Publishing via Composio and paid activation remain disabled. The quality/resource gates must pass before claiming a new autonomous end-to-end learning run.
