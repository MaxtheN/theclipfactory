# Growth Factory — submission video storyboard

**Working edit target: 2:00.** The target below is a production choice, not an assertion about the official limit. Confirm the dashboard requirements before export.

Format: 16:9 screen recording with founder voiceover and captions. Lead with the code-producing Factory builder to make the “software builds software” mechanism inspectable. Then show why the content workflow needs it. Use actual recorded code/test/render evidence; do not substitute animated mock logs.

| Shot | Time | Picture | On-screen text | Voiceover |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:12 | Pearl Studio Factory → Factory map; select Factory builder | **Growth Factory** · Your AI growth department on Mac | “Growth Factory coordinates content production. When the factory needs an editing capability it doesn't have, a builder can create the software for it.” |
| 2 | 0:12–0:28 | Factory upgrades: `progress_bar` request → bounded work order | **Request → work order** · Demo request, if applicable | “A missing progress bar becomes a work order with an exact interface, constraints and acceptance checks.” |
| 3 | 0:28–0:42 | Recorded generated extension diff; briefly show isolated branch/worktree context | **Real generated code** · Isolated worktree | “A builder writes the renderer extension and its tests in an isolated worktree.” |
| 4 | 0:42–0:55 | Actual static-check/test result and sample-render comparison | **12 generated tests passed** · Sample render checked | “The recorded build passed static checks, twelve generated tests and a real sample render.” |
| 5 | 0:55–1:05 | Reviewable diff and sample, with ready-for-review state | **Human review required** · Not merged or shipped | “It returned a reviewable change. This build was not automatically merged or shipped.” |
| 6 | 1:05–1:20 | Real source-backed clip in Studio; captions and quality/version details | **Real rendered draft** · Exact-version review | “The same factory turns brand direction and source footage into edited drafts. Quality checks help me review; I approve the saved version.” |
| 7 | 1:20–1:34 | Prepare your post: cover, caption and explicit destination; do not activate publication | **Approved publishing implemented** · First real app-post rehearsal pending | “The app prepares publication, but I choose the destination and approve the post. The first real app-post rehearsal is still a validation gate.” |
| 8 | 1:34–1:48 | Existing Strategist simulation, full banner visible; one evidence-to-proposal path | **SIMULATION — synthetic post data** | “This simulation shows evidence becoming a proposed next experiment. These are synthetic outcomes, not measured growth.” |
| 9 | 1:48–1:57 | Return to builder diff/test/sample artifact beside the Factory map | **Build → test → render → review** | “The content workflow exposes the need. The builder prepares a tested capability. People control what enters the factory and what goes live.” |
| 10 | 1:57–2:00 | Logo and repository/demo destination | **Growth Factory** | “Growth Factory.” |

## Evidence and edit rules

- **Builder:** use the actual documented `progress_bar` build artifact, generated tests and sample render. It ran in a temporary clone and was not pushed or merged. If the request came from “Try with a demo request,” retain its demo badge. [Builder proof](../factory-builder.md)
- **Clip:** a real-render shot must use playable, source-backed media. A sample-data UI preview does not prove transcription, editing or a provider operation. Identify prepared output honestly. [Engine evidence](../engine.md)
- **Publication:** implemented code/UI and an actual provider post are different claims. Do not imply successful publication or a completed live measurement cycle until the receipt/readback exists. Recording is not permission to post. [Publishing](../instagram-publishing.md), [current live gates](../HANDOFF.md)
- **Simulation:** keep **SIMULATION — synthetic post data** visible throughout the shot. If early real collection uses Measure now, show its `demo_override` label and real elapsed window; do not call it a three-day result.
- **Routing:** do not caption the entire app “100% local.” Local and optional cloud routes coexist; approved publication shares media externally.
- **Privacy:** redact credentials, session values, private account identifiers and raw provider payloads. Use cleared footage; do not imply example brands endorse the product.
- **Pacing:** show short recorded proof segments rather than waiting for a full model/render job. Time compression must not conceal failed checks or replace evidence with decoration.
- **Fallback:** if the code/test/render artifacts cannot be inspected, label that gap and revise the submission claim. If Strategist simulation is unavailable, replace shot 8 with a plainly labeled architecture diagram, not invented metrics.
- **Final check:** match the video to the submitted commit, tool/license and pre-event-work disclosures. No claim of audience lift, agency savings, autonomous ad spend or self-deployment is supported by this storyboard.
