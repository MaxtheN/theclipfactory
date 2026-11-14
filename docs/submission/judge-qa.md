# The 12 hardest judge questions

**1. How do you know the hook change *caused* better performance?**
We don't, and the product says so. Organic Instagram data is observational: different posts, times and audiences, and the counts are blended with paid and crossposted reach. That's why each experiment changes one variable, compares against the account's own median baseline, labels every comparison "observational", and needs a human to promote any rule. Causal evidence comes with the brand line, where a paid A/B split randomizes delivery. <!-- docs/learning-loop.md; docs/composio-setup.md "Attribution is not_separated" -->

**2. Then what does the loop actually prove today?**
Execution, not outcomes. Here's the chain we verified: a real post maps to an exact approved clip. A real provider snapshot is saved. The analyst cites that snapshot and proposes one bounded change. The changed variant is really rendered with lineage and starts unapproved. Audience growth is a separate claim, and we don't make it. <!-- docs/finish-line.md "Demo acceptance" -->

**3. Why local models instead of GPT or Claude?**
There are three reasons. Privacy: unreleased episodes and transcripts never leave the Mac. Cost: no per-token bill, so watching a whole multi-hour source scene by scene costs nothing at the margin. Control: grammar-constrained output and deterministic repair. The trade-off is capability and memory, which is why the code does the measuring and a bounded 4B model only chooses and describes.

**4. A 4B model is small. Is the quality good enough?**
Our tests show 4B is the floor. The 1.7B model fit in memory but failed our handoff and quality contracts, and we record those runs as failures. 4B with an 8K context produced a validated, source-faithful proposal, and a 90-second source produced a complete, critic-checked 15.1-second clip in 119.2 seconds. Editorial acceptance is still a human judgement. <!-- docs/learning-loop.md; docs/demo-acceptance.md -->

**5. What does a clip cost? Is this BYOK?**
Inference has no per-call API cost because it runs on your hardware. The only external service is Composio for Instagram reads, and that uses your own project key, stored in macOS Keychain. We haven't published a fully loaded cost per accepted clip. The acceptance plan tracks elapsed time, human minutes, direct cost with exclusions, and reviewer acceptance against a manual baseline before we claim any saving. <!-- docs/finish-line.md item 7; docs/composio-setup.md -->

**6. What happens if the laptop closes?**
Nothing is lost, and nothing is duplicated. Work, leases and receipts live in SQLite. Due measurements catch up when the app reopens. An unknown render submission is reconciled against exactly one saved job and never blindly resubmitted. Always-on collection needs a hosted worker, which is on the roadmap. The Supabase schema alone isn't a worker. <!-- docs/learning-loop.md; docs/finish-line.md -->

**7. How is this different from Opus Clip or other AI clippers?**
They stop at the clip. We close the loop: the clip maps to a real post, the post becomes a snapshot, the snapshot leads to one cited change, and the change becomes a rendered next draft and a proposed Style rule, all with lineage. We also watch every scene with a vision model instead of just reading a transcript, run locally, and require human approval of the exact file. The clipping is the entry point. The moat is account-specific creative memory.

**8. Who is the enterprise buyer?**
First, podcast networks and media teams with a backlog of long-form content and a small social team. They need volume and a defensible record of what was approved and why. Next, D2C brands, through the brand line (catalog → formats → paid tests → ROAS). The buyer is whoever owns content performance: a head of social or a digital media head. The audit trail (who approved which exact bytes, on what evidence) is what enterprise compliance asks for.

**9. What about data privacy?**
Footage, transcripts and model calls stay on the Mac. Credentials sit in Keychain, never in SQLite or Git. Composio has four read-only Instagram tools, and publishing tools are rejected. The cloud schema holds 3 owner-private tables under 7 forced RLS policies, with no service-role key in the app. Syncing anything requires a reviewed field-level projection that excludes credentials, local paths, media and raw logs. App sync is not yet enabled. <!-- docs/cloud-state.md; docs/composio-setup.md -->

**10. How does this scale beyond one laptop?**
Today it's deliberately one Mac, one heavy lane and serial inference. To scale: hosted workers for collection and learning, cloud sync over the existing RLS schema with conflict and version handling, team membership, and optionally hosted inference for teams that accept it. The ledger, lineage and evidence model don't change. Only where the workers run changes.

**11. Why not auto-publish? Isn't that the point of automation?**
Publishing is irreversible and public, and Instagram's publish API has no idempotency key. A timeout after a write is an unknown outcome. Safe publishing needs exact approval, public HTTPS hosting, a durable claim before the write, and reconciliation. We documented that design but didn't ship a half-version of it. Automation here covers the expensive parts: finding moments, rendering, measuring and proposing. <!-- docs/composio-setup.md "Later: approved publishing handshake" -->

**12. Is the Strategist real or a slide?**
The code exists and is being integrated: three layers (craft, moment selection, campaign), a deterministic Beta-Bernoulli confidence ledger, and a seeded explore/exploit portfolio with a 25% explore share. The model only names beliefs from a fixed vocabulary and writes the rationale. In the demo it runs in a labelled Simulation on synthetic posts, because a single account doesn't yet have enough measured posts for real beliefs to leave "testing" (minimum 3 matching posts). <!-- clip_factory/strategist.py constants -->

**Bonus: is this "AI learning" just prompt stuffing?**
It's policy memory, not weight training. It's a versioned, human-approved creative policy plus a bounded, deterministic digest of evidence, cited by ID. That makes it inspectable and reversible, and nothing changes without a person approving it.
