## Inspiration

A small marketing team has to behave like an entire department: understand the brand, find a story, edit it, publish it, read the results and decide what to try next. Those tasks usually live in separate tools. The learning rarely makes it back into the next edit.

We wanted a growth department that keeps that work connected. We also wanted it to recognize when its own software is the bottleneck—and build a tested tool to remove that bottleneck.

## What it does

**Growth Factory is an AI growth department for Mac, with a software factory inside it.** Video content and Instagram are its first production line.

You set the brand, audience, goal and boundaries. Agents turn source footage into ranked, captioned vertical drafts. You review the exact version, request changes and choose what can be published. Account observations can inform a specific next creative experiment instead of disappearing into an analytics tab.

When the factory encounters an editing capability it lacks, it creates a structured work order. A builder agent writes a renderer extension and tests in an isolated worktree. Static checks, generated tests and an actual FFmpeg sample render evaluate the result. The app presents the diff, logs and sample for human review. The extension reaches the running app only after reviewed integration and restart.

That is our software-building-software loop: **capability gap → code → tests → rendered evidence → human review → a more capable factory.**

## How we built it

The desktop app combines a React/TypeScript interface, pywebview, FastAPI, SQLite and FFmpeg. The Pearl Studio interface groups daily work into Factory, Library, Results and Brand profile. Jobs, decisions, versions and evidence persist locally.

Whisper transcribes speech on the Mac. Agents can use supported local models or explicitly configured OpenRouter cloud routing. They propose source-backed moments and edit plans; code validates schemas, measures timing, applies constraints and renders the result. Editing supports payoff-first openings, title cards, word captions, face-follow framing where available, measured jump cuts, loudness normalization, covers and brand styling.

Composio connects the Instagram workflow. The implemented publishing path uses explicit approval, Supabase-hosted media and durable attempt records. Unknown provider outcomes require reconciliation. Supabase also supports account sign-in; broader cloud state synchronization and always-on workers are separate work.

The Strategist keeps inspectable beliefs and proposes creative-policy changes. Synthetic simulations are labeled throughout. The builder uses a constrained extension interface, static checks, bounded execution and a sample-render comparison; generated branch code is not automatically imported by the running app.

## What we are proud of

We connected creative work to an inspectable software-development loop. In a documented live rehearsal, the builder generated a `progress_bar` extension in a temporary clone in **29 seconds**, with **$0.0535** in provider-reported model cost. Its static checks, **12 generated tests** and sample render passed. The generated change was not pushed or merged. This demonstrates one bounded coding task, not a general success-rate or cost claim.

We also have real source-to-render evidence for captioned vertical clips, separate provider account/insight readbacks, and automated coverage for approval, scope, recovery and lineage. The full frontend suite passes locally with resource-bounded workers. A quality score, a technical pass and a person's editorial approval remain distinct.

## Challenges we faced

Local inference, speech models and video rendering compete for the same memory on a laptop. Missing or damaged speech assets can produce convincing-looking but poorly grounded work, so readiness and transcript evidence must be explicit. A short hook can also distort a speaker's meaning; ranking is a review aid, not a truth certificate.

Another challenge is separating successful execution from a successful business outcome. Organic metrics are observational. A rendered variant is not an approved post. A timeout after publication is not permission to publish again. Those distinctions shaped our state machines and interface.

## What we learned

Agents are most useful when they have a narrow job, an explicit contract and evidence a person can inspect. The same is true for generated code: a plausible diff becomes useful only when it passes checks and produces the intended output.

Our creative memory changes versioned policy and editing decisions. It does not retrain model weights or guarantee audience growth.

## What's next

Complete a fresh human-reviewed generation rehearsal, approve the exact clip and caption for the first real app publication, and verify the resulting post and learning cycle. The publishing flow is implemented, but that first live app post is still an acceptance gate.

Then expand the reviewed extension library, improve the human editorial benchmark, add always-on workers and harden Mac distribution. More channels, commerce and controlled paid experiments are future production lines. Autonomous ad spending and causal growth lift are not current claims.
