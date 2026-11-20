# The Strategist

The Strategist is Growth Factory's three-layer learning agent. It reads an
account's own measured posts, keeps a ledger of beliefs about what tends to
beat that account's median, plans the next batch of experiments, and writes
**proposals only**. A human approves every change on the existing screens.
Nothing here approves, publishes or spends.

Source: `clip_factory/strategist.py` (engine), `clip_factory/strategist_api.py`
(API, local model adapter, scheduler hook), `Campaigns.propose_from_beliefs`
(`clip_factory/campaigns.py`), `frontend/src/growth/StrategistPanel.tsx`,
`BeliefLedger.tsx`, `strategistApi.ts`.

## Architecture

```
 Composio insights ──► LearningEngine.tick() ──► learning_snapshots (cumulative, immutable)
                                                       │
 AutonomyRuntime.run(): after tick ─► strategist_tick ─┤ scheduled_tick: queue ONE due profile
 POST /api/strategist/{p}/run ───────────────────────► │ as a "strategist" job on the heavy worker
                                                       ▼
   measured_posts(): publication → LATEST snapshot → clip → tag_clip()   (deterministic tags)
   account_baseline(): learning.memory_digest() per-metric median        (null when unknown)
                                                       │
           ┌───────────────────────────────────────────┼─────────────────────────────┐
           ▼                                           ▼                             ▼
   local model (optional)                    deterministic pattern scan       evaluate_belief()
   admission guard before EVERY call         names candidates seen on ≥2      Beta-Bernoulli confidence,
   ≤3 hypotheses in allowed vocabulary,      posts (no scores)                shrunken log-ratio, status
   cites evidence IDs; 1 repair; abstain                                                │
           └──────────────────────────► beliefs (ledger) ◄──────────────────────────────┘
                                                       │
                     ┌─────────────────────────────────┼──────────────────────────┐
                     ▼                                 ▼                          ▼
          craft: PROPOSED workspace       selection: PROPOSED moment_selection   campaign: campaign_strategy_proposals
          Style-rules revision            guidance block (same path)             per campaign (human Approve/Reject)
          (Campaigns.propose, "strategist")            │
                                                       ▼ only after a human approves the version
                       team.py: campaign_snapshot.strategy_snapshot → selection_guidance
                       → producer brief + swarm scene prompts (bounded, 600 chars)
                                                       │
                                plan_portfolio(): ~75% exploit / ~25% explore, seeded
```

## The three layers

| Layer | Variables (tags) | Cadence | Writes |
| --- | --- | --- | --- |
| Craft | hook_style, duration_bucket, opening_type, caption_style, framing | each new measured snapshot | Proposed Style-rules revision: `duration_seconds`, `caption_style` (standard/high_contrast), `framing` (fit/fill) where mappable, plus a bounded guidance block in `editing_preferences` |
| Selection | moment_type (the swarm hypothesis), speaker_role | every ≥3 new tagged measured posts | Proposed revision whose `moment_selection` carries a bounded guidance block; once **approved**, team/swarm prompts receive it as `selection_guidance` |
| Campaign | posting_window (creator's time zone), day_type | every ≥8 new tagged measured posts, or manual run | `campaign_strategy_proposals` record; `POST /api/strategist/campaign-proposals/{id}/decision` records the human's choice |

A manual "Run strategist" reviews all three layers. Beliefs are per workspace
(`profile_id`). Craft and selection write ONE proposal per layer to the
workspace's Style-rules set (`Campaigns.propose_from_beliefs(profile_id, …)`,
`scope: "workspace"`), rebased on its active approved version, so every
campaign in the workspace inherits it once approved. Campaign-layer proposals
stay per campaign (at most three active campaigns). A pending or approved
proposal for the same belief (and, for the campaign layer, the same campaign)
is not duplicated; a rejected one is not re-proposed until the belief has at
least three more matching posts.

## Tags

`tag_clip(clip, publication)` derives features from saved records only:

- `hook_style`: quote / question / number / how_to / statement from the hook text.
- `duration_bucket`: short < 20 s ≤ medium ≤ 40 s < long (main range + cold open).
- `opening_type`: explicit `opening_treatment`, or the renderer's documented legacy
  rule (hook overlay + hook text, no cold open → text_overlay).
- `caption_style`, `framing`: from the edit plan.
- `moment_type`: the clip's swarm `hypothesis`. Team-mode clips have no such field yet, so it is null.
- `speaker_role`: only if a clip records it (nothing does today), else null.
- `posting_window`, `day_type`: from the verified publication time, read in the creator's time zone.
  That is the `time_zone` setting (an IANA name such as `America/Los_Angeles`, set with
  `PATCH /api/settings`), or this computer's zone when it is empty or unknown. Daylight-saving
  changes are followed. Windows: morning 05–12, afternoon 12–17, evening 17–22, night 22–05.
  Pattern-scan statements name the zone, e.g. "posting in the evening (America/Los_Angeles)".
  The simulated demo and library callers keep UTC so their results do not depend on the machine.

Unknown is always null and is never matched.

## Math (all deterministic code; the model never sets a number)

- **Baseline**: `learning.memory_digest()` baseline, which is the median per metric
  across each tracked post's LATEST cumulative snapshot. Unknown values are
  null, never zero; snapshots are never summed. Goals are campaign-scoped: the target
  metric is the most recently updated active campaign's `primary_metric` when known, then
  the workspace's legacy metric, otherwise views → plays → reach → impressions → likes.
- **Per-post outcome**: for a belief "posts with variable=value tend to beat
  (or fall short of) the median", each matching post with a known value and
  known baseline is a success or a failure. Ties count as neither.
- **Confidence** = P(rate > ½) under Beta(1 + successes, 1 + failures), computed
  exactly as a binomial sum. It starts at 0.5, rises with each success and falls
  with each failure, and always stays strictly between 0 and 1.
- **Uncertainty** = posterior standard deviation relative to the uniform prior (1.0 means nothing is known yet).
- **Effect** = shrunken mean of log((value+1)/(baseline+1)) with 2 pseudo-posts of zero effect. Shown for context only.
- **Status**: proposed (no evidence), testing, **supported** (≥3 posts, confidence
  ≥ 0.8 **and** at least one matching post published after the belief was named),
  weakened (≥3 posts, confidence ≤ 0.25), retired (by a human only, and it stays retired).
  The rule about posts published after naming guards against confirming a pattern
  using only the data that suggested it.
- **Portfolio**: of N slots (default 4), round(N × 0.25) (minimum 1) go to
  "explore", taking the highest uncertainty × fixed importance weight among
  proposed/testing beliefs. The rest go to "exploit", in confidence order among
  supported beliefs. Seeded tie-breaking (`profile:run_count`) makes it
  deterministic. When nothing is supported, every slot explores.

## Model role and safety

The qualified local analyst is the only model used: `qwen3-vl:4b` through Ollama,
with an 8,192-token context. `LocalModel.admit()` holds when:

- the configured model is not that one,
- the call is outside a queued job, or
- `AutonomyRuntime.resource_check` reports that the memory admission guard is not ready.

The guard runs before every inference, including the repair call. When the model
is held, the run still scores beliefs, scans for patterns and plans the queue,
and the UI says "Model held: insufficient memory".

Output must be `HypothesisSet` JSON (max 3) and must pass these checks:

- uses only an allowed layer, variable and value, with the layer reviewed in this run;
- every evidence ID is a publication or snapshot ID shown in the prompt;
- contains no percentages, multipliers, "confidence" or "proof";
- includes no extra fields, so a model cannot set a confidence.

Invalid output gets one correction. If it is still invalid, the run abstains and
nothing is fabricated. Duplicates of existing beliefs are dropped.

## API (authenticated like every `/api` route)

- `GET /api/strategist/{profile_id}`: returns beliefs, lanes, baseline, target
  metric, tagged posts, due layers, portfolio, pending proposals and the last 5
  run receipts (including model held/abstained), with `simulated: false`.
- `POST /api/strategist/{profile_id}/run` `{layer?}`: returns 202 with a queued
  receipt. The run is a "strategist" job on the heavy worker.
- `POST /api/strategist/beliefs/{id}/retire` `{reason?}`
- `POST /api/strategist/campaign-proposals/{id}/decision` `{approve, reason?}`
- `POST /api/strategist/{profile_id}/simulate` `{seed?, steps 4–40}`

The API returns 404 for a missing profile. It returns 409 for an archived
profile, when all of the profile's channels are archived, or when a run is
already in progress. Style-rule proposals are refused for an archived
workspace (`Campaigns.active_workspace`); campaign-layer proposals are never
written to archived campaigns. If a job ends without finishing its receipt, the
receipt is closed as failed.

## Real vs simulated vs unproven

**Real**

- Tags, baselines, confidence and portfolio are computed from saved
  publication, snapshot and clip records.
- Proposals go through `Campaigns.propose`, so the stale-base and
  profile-coverage guards apply when they are created and again when approved.
- Approved selection guidance reaches team and swarm prompts.
- The scheduler queues a run after metric collection.

**Simulated**

- `/simulate` builds a synthetic channel in a throwaway `MemoryStore` with seeded
  random posts. Hidden "true" multipliers are returned as `synthetic_truth`, so a
  viewer can check what the strategist found.
- It runs the same `Strategist` code: tagging, scoring, scan, portfolio and
  proposal records, all in memory. Each new synthetic post follows the current
  portfolio slot.
- The local model is never used in simulation. Every response and step carries
  `simulated: true`, and the UI shows a permanent banner. Nothing is persisted.
- Expect some false patterns at small sample sizes. Those are honest noise, not a bug.

**Unproven**

- No live model run of the hypothesis prompt has been done; tests use fakes.
  Whether qwen3-vl:4b produces valid hypotheses, and how often it abstains, is unmeasured.
- No real account has enough tagged, measured posts yet to support a belief.
- The posts compared differ in age at measurement, because the latest
  cumulative snapshot is not age-normalized. Audience and time also differ.
- Every belief is observational, and testing many variable/value pairs inflates false positives.
- Posting windows use one zone for the whole app; an audience in another zone is not modelled. Moment type exists only for swarm clips.
- The campaign layer records an approved plan; nothing yet acts on it automatically.

## Honest demo script

1. Open **Results**. In the Strategist section, say: "These beliefs come from this
   account's measured posts, compared with its own median. Each one is labelled
   observational."
2. Click **Run strategist**. Show the real progress. If memory is tight, point to
   "Model held: insufficient memory": the math still ran and the model was not forced.
3. Point to an evidence chip, for example "post a1b2c3 · views 1.42× median", and
   hover it to show the snapshot ID.
4. Show the **Next batch** strip: three Apply slots and one Explore slot, with the reason for each.
5. If there is a pending proposal, click **Review in Style rules**. Approval still
   happens there, through the existing guard.
6. Click **Play simulation** and read the banner aloud. Say: "This is synthetic
   data. It shows how the same code reasons over twenty posts. The answer key is
   in the response, so you can see what it found and what it got wrong." Then
   click **Back to real data**.
7. Do not claim lift, causality or a live model result that has not been shown.
