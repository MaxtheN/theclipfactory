# Growth Factory — judge questions

Current submission baseline: the integrated Pearl Studio app. These answers describe implemented mechanisms separately from live proof and remaining launch gates. Recheck the [engineering handoff](../HANDOFF.md) and final submission evidence before presenting.

**1. How does this fit “software builds software”?**

The Factory builder is an implemented code-producing workflow. A missing editing capability becomes a structured work order. After a person starts it, a builder works on an isolated Git branch, writes a renderer extension and tests, runs static checks and a sample render, and returns a reviewable diff and receipts. The documented `progress_bar` build passed 12 generated tests and the sample render in a temporary clone. Nothing from that build was pushed or merged. This is the concrete software-building mechanism; content production is its use case. [Factory builder](../factory-builder.md)

**2. What is Growth Factory beyond that builder?**

An AI growth department for Mac, starting with video and Instagram. Brand direction informs source analysis, editing, review and publication preparation. Post evidence can lead to a proposed next experiment and versioned Style rules. The product connects these decisions rather than treating every clip as an isolated prompt. Broader commerce, channels and paid optimization remain roadmap work. [Product direction](../product-roadmap.md)

**3. Does the builder deploy its own code?**

No. It prepares code, tests and a sample for review. Generated code is constrained and checked before execution; the running app does not import the builder's unreviewed worktree. A human reviews and integrates a change, and the extension loader checks the committed code before making it available. The recorded build proves generation and checks, not automatic deployment or a merged production feature. [Builder checks and integration](../factory-builder.md)

**4. What has actually been proven?**

The repository records real source-backed clip renders, provider account/insight readbacks and a real builder code/test/sample-render run. These are separate evidence items. The first app-initiated Instagram publication and its complete post → aged metrics → changed draft rehearsal remain a live gate until verified. Unit tests, rendered media, provider reads and synthetic simulation establish different things; none alone proves audience growth. [Engineering handoff](../HANDOFF.md), [render evidence](../engine.md), [builder evidence](../factory-builder.md)

**5. Does everything run locally?**

The Mac app runs its local service and SQLite execution state; Whisper transcription and supported local model inference are available. Optional cloud routing uses the configured provider and may send selected text or still frames. Approved publishing uploads the media so Instagram can fetch it. We show the chosen route and do not claim universal on-device privacy. [Model routing](../HANDOFF.md), [publishing](../instagram-publishing.md)

**6. What does it cost?**

Local inference avoids a per-call model API charge but still uses hardware, time, memory and power. Optional cloud calls have usage costs, and connected services have their own limits. The documented builder run cost $0.0535 as reported by its provider; that is one run, not a forecast or a fully loaded cost per accepted asset. We have not established an agency-savings or cost-per-customer claim. [Recorded builder run](../factory-builder.md), [resource policy](../runtime-resource-policy.md)

**7. How do you know an edit caused better performance?**

We do not infer causality from organic post comparisons. Audiences, posting times and distribution differ. The learning system preserves evidence and uncertainty, compares compatible account-specific observations, and proposes bounded changes for review. Synthetic outcomes illustrate the decision process, not audience lift. Controlled paid experimentation is a future direction and would still need an appropriate experimental design. [Learning contract](../learning-loop.md), [roadmap](../product-roadmap.md)

**8. What do the quality scores mean?**

The engine ranks candidates and separately checks technical/review readiness. These scores help triage drafts; they are not predicted views, a guarantee of editorial quality or permission to publish. A critic pass never substitutes for human approval of the saved version. Unknown or failing checks stay visible; a supported quality override is an explicit recorded decision. Do not claim the newer experimental scoring backend is part of the submitted build until it lands. [Engine](../engine.md), [pre-post gate](../instagram-publishing.md)

**9. What prevents the agents from publishing or spending freely?**

Production and learning prepare drafts and proposals. The posting flow requires an approved clip/version, an explicit verified destination and a deliberate publication action; it records attempt state before external writes. Uncertain outcomes require reconciliation rather than a blind retry. Scheduling requires the app to be open, and overdue work needs attention. No paid activation or spending is part of this demo. Implemented safeguards still need the first real publishing rehearsal. [Publishing state machine](../instagram-publishing.md), [execution boundaries](../autonomous-marketing-factory.md)

**10. What happens when the Mac closes or a provider fails?**

SQLite retains saved jobs, evidence and attempt receipts. Due local work can be recovered when the app reopens; ambiguous external writes are held for reconciliation. This is recovery behavior, not an absolute promise that every failure is lossless. Collection while the Mac is closed needs a hosted worker, which remains later work. [Learning and recovery](../learning-loop.md), [publishing recovery](../instagram-publishing.md)

**11. How is “learning” different from retraining a model?**

Here learning means evidence-backed policy memory: saved observations, proposed experiments and versioned creative rules. A human decides whether a proposal becomes active. Model weights are not retrained by the app, a simulation does not become a real observation, and a higher quality score does not prove business improvement. [Strategist](../strategist.md), [learning loop](../learning-loop.md)

**12. What remains before a public launch?**

A fresh-user rehearsal, the first approved app publication and mapping, and an inspectable real feedback cycle; independent-account connection verification and provider permissions; distribution/release hardening; and, later, cloud state sync, hosted workers and team access. Growth Factory sign-in is implemented, but that is separate from Instagram authorization and from cloud synchronization. The app's broader marketing department and paid-media vision are not all shipped. [Current handoff and gates](../HANDOFF.md), [Instagram connection requirements](../instagram-connect.md), [product roadmap](../product-roadmap.md)

## Disclosure reminders

Use the submission's final work/pre-event disclosure and tool/license list. Attribute dependencies and third-party media. Never show credentials, private account identifiers or unredacted provider payloads. Keep every simulation label visible, and identify prepared historical proof as prepared historical proof.
