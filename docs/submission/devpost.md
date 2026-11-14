# Growth Factory: a marketing team that learns from your own posts

<!-- Sources: every number below cites its doc in an HTML comment. Anything not sourced is described qualitatively. -->

## Inspiration

Every podcast episode has a dozen good 30-second moments in it, and most of them never get posted. Teams that do post clips run into a second problem. Clips go out, the numbers come back, and nobody turns those numbers into the next edit. The analytics tab is where the learning stops.

I sketched the product I wanted in a notebook. It's a "Digital Media Head" that runs two production lines. The **channel** line goes editor → clipping → publish → engagement → "what worked? double down". The **brand** line goes paid ads → different formats → ROAS → change format → iterate. Both lines run the same loop: make something, measure it, change one thing, make it again. For the hackathon we built the channel line, and we built it properly.

<!-- Source: research/growth-factory/integration/product-expansion-sketch.png; docs/product-roadmap.md "One factory, two production lines" -->

## What it does

Growth Factory is a Mac desktop app. You give it a full podcast episode, and it gives back captioned 9:16 clips plus a written next experiment grounded in your own account's numbers.

1. **Set up the channel once.** Audience, goal, voice, boundaries.
2. **Add an episode.** The app transcribes it locally and watches every scene. Then a team of agents (or a faster swarm) picks moments and renders 1080×1920 captioned drafts.
3. **Review and approve the exact file.** The approval is tied to that specific revision and its checksum. A critic's "pass" never counts as approval.
4. **Connect Instagram and track a real post.** Accounts are verified through Composio, and reads are read-only. You post the clip yourself, then confirm which approved clip that post used.
5. **Learn.** After 3 or 6 days the app saves an immutable metric snapshot. A local analyst compares it with your own account's baseline. It either proposes **exactly one** change (hook or duration) with cited evidence, or it abstains and says why.
6. **Next draft.** The changed variant is actually rendered, starts unapproved and keeps its full lineage (parent, source, experiment, job, hash). A matching Style rule is proposed, and nothing changes until a human approves it.

Publishing is intentionally not automated. A person approves every post, and the app never spends money.

<!-- Sources: docs/channel-and-production-flow.md "Daily flow"; docs/learning-loop.md "Durable contract", "Closing the loop"; docs/autonomous-marketing-factory.md "Execution boundaries" -->

## How we built it

**Stack.** pywebview native shell, local FastAPI backend, React/Vite UI and SQLite. Credentials live in macOS Keychain. FFmpeg handles all measurement and rendering. Supabase handles email+password sign-in.

**Local models.** MLX Whisper large-v3-turbo transcribes. Ollama `qwen3-vl:4b` (a vision-language model) runs the agents. No footage or transcript leaves the Mac for inference.

<!-- Sources: clip_factory/models.py (whisper-large-v3-turbo MLX); clip_factory/autonomy_runtime.py (ollama:qwen3-vl:4b-instruct); git b5fd6ee (Supabase sign-in) -->

### Agent roles

The design principle is **"Models choose and describe; code measures."**

| Agent | What it does |
|---|---|
| Storyboard watcher | FFmpeg splits the whole source into scenes using picture change, loudness and cuts. The VLM describes timestamped frames plus the speech in each scene. Every later agent refers to scenes by ID. |
| Scout swarm | For sources over 20 minutes, one scout reads each 10-minute chunk and proposes at most two scored moments. A selector then picks distinct winners from a diversity-first shortlist. |
| Producer | Writes the brief from the channel audience/goal, approved Style rules and learning memory. |
| Footage analyst | Selects moments by citing scene IDs. Start and end times are computed from those citations, not typed by the model. |
| Creative strategist | Chooses the angle and hook from dense frames around each moment's peak. |
| Editor | Plans the cut around a suggested peak, using frames from inside its range. |
| Critic | Checks context, claim support, captions and duplicates against verbatim speech. Missing evidence stays "unknown", and unknown blocks approval. |
| Performance analyst | Uses past experiments and comparisons as citable evidence (`experiment:<id>`, `comparison:<id>`). |
| Learning analyst | Reads one saved snapshot plus the memory digest. Proposes one hook-or-duration change, or abstains. |
| Experiment producer | Renders the variant from the original source with a frozen production request, then reconciles it against exactly one saved job. |

The roles are fresh-context calls against **one shared model** on a single heavy lane. The team is a logical collaboration, not six models loaded in parallel. Each handoff is grammar-constrained to a bounded schema. There are at most two correction cycles, and a repeated edit stops as "no progress." Team permissions are hard-coded to `{publish:false, ads:false}`.

<!-- Sources: docs/team-mode.md; clip_factory/team.py, storyboard.py, scouts.py module headers; README "How the factory works" -->

### Custom tools

- **Composio Instagram adapter.** Only four read tools are enabled, and each is pinned to an exact schema. Before every read the adapter checks the exact connected account, owner and configuration, plus the professional Instagram identity. Media ownership and publication time come from the provider and are never typed in by hand. Publishing tools are rejected even through generic execution. We verified two real accounts with live post and insight reads.
- **Resource admission guard.** Before every local inference, including repair attempts, it requires at least max(6 GiB, weights + 3 GiB) of available RAM, normal kernel memory pressure and a context window of 8,192 tokens or less. Otherwise the call is held with stated reasons.
- **Memory digest.** A deterministic, size-bounded summary of the account's experiments. The baseline for each metric is the median of each post's *latest* cumulative snapshot. Unknown values stay null rather than becoming zero.

<!-- Sources: docs/composio-setup.md "Actual account verification — 2026-11-14"; docs/runtime-resource-policy.md; docs/learning-loop.md "Closing the loop" -->

### Automated workflows

- **Autopilot production.** Attaching footage under an approved direction starts production by itself. Clips always wait for review.
- **Durable learning worker.** Measurement at 3 and 6 days, leases and backoff, at most 3 retries on reads and at most 1 validation repair per analyst job. Unknown outcomes are reconciled, never blindly retried. The worker runs while the app is open and catches up on reopen.
- **Measure now (demo).** One button moves a single mapped post's due time to now. The provider read is still real, and every resulting record is badged `demo_override` with the real elapsed hours.

<!-- Sources: README; docs/learning-loop.md "API and UI", "Demo trigger: measure now" -->

### In progress: the Strategist

We are building a three-layer Strategist:

- **Craft**, run on each measured post, which proposes Style rules.
- **Moment selection**, run every 3 or more tagged posts, which proposes selection guidance.
- **Campaign**, run every 8 or more tagged posts, which proposes posting windows.

All the numbers are deterministic code: feature tags, a Beta-Bernoulli confidence ledger, shrunken effect sizes and a seeded explore/exploit portfolio with a 25% explore share. The model can only name candidate beliefs from a fixed vocabulary and write the rationale. A clearly labelled **Simulation** mode runs the same scoring code over synthetic posts so you can watch it reason. It is never presented as real results.

<!-- Source: clip_factory/strategist.py header and constants (uncommitted, in progress at submission time; no docs/strategist.md) -->

## Challenges we ran into

- **Memory on a laptop.** A 4B vision model with a 16K context allocated about 2.3 GB of KV cache on top of 2.37 GB of weights, and pushed a 16 GB Mac to critical memory pressure. We cut each request to 8K and built an admission guard that holds instead of crashing. <!-- docs/runtime-resource-policy.md -->
- **Small models that fit but fail.** The 1.7B model fit in RAM but failed our handoff and quality contracts. We kept the 4B model and record the 1.7B runs as failures, not successes. <!-- docs/learning-loop.md "Actual model qualification" -->
- **Long sources.** A single prompt over a 3.4-hour stream returned over-long ranges of 72–158 seconds. The scout swarm kept every clip within 60 seconds and spread the picks across the whole source. <!-- clip_factory/scouts.py header -->
- **Honest measurement.** Instagram counts are cumulative, lifetime and blended with paid and crossposted reach. We never sum snapshots, we keep real zeros separate from unknowns, and we label every comparison "observational." <!-- docs/composio-setup.md "Exact-media observations" -->
- **Proving which post is which clip.** The provider can verify the account, the media and the publish time. It cannot prove the remote bytes match a local MP4, so a human confirms the mapping. <!-- docs/finish-line.md "Remaining live gates" -->

## Accomplishments we're proud of

- An end-to-end real run on a 90-second source. Whisper and Qwen 4B produced one complete 15.1-second point in 119.2 seconds, with footage grounding passing and no fallback. Word boundaries, subtitles, critic checks and the media hash were all verified. <!-- docs/demo-acceptance.md "Final creative execution gate" -->
- The learning analyst produced a validated, source-faithful proposal, and FFmpeg actually rendered the changed variant. It was not a mock. <!-- docs/finish-line.md; docs/learning-loop.md -->
- Two real Instagram accounts were verified through provider readbacks, with live post and insight reads (three and four usable recent posts). <!-- docs/composio-setup.md -->
- A cloud schema with 3 owner-private Supabase tables and 7 RLS policies, verified with JWT probes inside a rollback. <!-- docs/cloud-state.md -->
- A system that says "I don't know." The analyst abstains, unknown critic checks block approval, and no winner is ever invented.

## What we learned

- Let models describe and let code measure. Computing a timestamp from a cited scene ID removed a whole class of hallucinated ranges.
- Validation and repair beat retries. A schema with one bounded repair turn gets more usable output from a 4B model than a bigger prompt does.
- "Learning" doesn't have to mean training weights. Here it is a versioned, human-approved creative policy built from immutable evidence. That is auditable, reversible, and runs on a laptop.
- Organic social data is observational. Being honest about that shaped the product: one variable per experiment, comparisons against the account's own baseline, and human promotion of every rule.

## What's next

From the right-hand page of the sketch:

1. **The brand / D2C line.** Product and catalog context (Shopify, landing pages) → multiple creative formats → reviewed paid-ad proposals → ROAS by format → change format → iterate. This is where the loop gets *causal* evidence. A real paid A/B split randomizes delivery, so "variant B beat variant A" becomes a controlled result instead of an observation. Today a live read-only Meta Ads preflight exists, but no ads are created or spent. <!-- docs/product-roadmap.md; docs/paid-experiments.md -->
2. **More channels.** YouTube is the next integration. TikTok follows, after its own developer, OAuth and audit gates. <!-- docs/product-roadmap.md -->
3. **Reviewed publishing.** Exact approval, trusted public HTTPS hosting, a durable attempt claim and unknown-outcome reconciliation. <!-- docs/composio-setup.md "Later" -->
4. **Always-on operation.** A hosted worker so measurement continues with the laptop closed. Also cloud sync over the existing RLS schema, team access, and a signed, notarized Mac release. <!-- docs/product-roadmap.md; docs/cloud-state.md -->

## Built with

Python, FastAPI, Pydantic, SQLite, pywebview, React, Vite, TypeScript, FFmpeg, MLX, MLX Whisper (large-v3-turbo), Ollama, Qwen3-VL 4B, Composio, Instagram Graph API, Supabase (Auth + Postgres RLS), macOS Keychain.
