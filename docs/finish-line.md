# Growth Factory finish line

## The daily flow

Set podcast/brand name, audience and objective once. Return to Factory, upload footage, inspect real agent work, review the cuts and approve the exact file. Library retains sources, versions and exports. Results shows measured evidence, its limits and the next proposed edit. Context remains editable in Workspace settings.

## What the team already built on master

SQLite stores local profiles, campaigns, immutable direction versions, jobs, clips, observations and exports. A serialized local worker handles transcription, frame inspection, planning, rendering and critique. Ollama vision models and MLX models have distinct readiness rules. Real FFmpeg outputs have technical checks, linked revisions, SHA256 checksums and export manifests. The operational UI exposes model setup, ledger/comparisons, Instagram connection/publishing/reconciliation, insights and paid preflight.

## Owners and next integration gates

| Owner | Deliverable | Acceptance |
| --- | --- | --- |
| Kartik | Onboarding, Factory, Library, Results and Studio wiring | Simple daily flow, exact account/version context, retained drafts, real operations and recoverable failures |
| James | Reliable agent-to-render path | Run the intended local vision model on the supplied All-In footage; inspect each failed role/error, produce usable plans and real playable clips |
| Nur | Persistent workflow and analytics handoff | Reopen saved work, recover interrupted jobs, link each publication/insight to an exact clip/account and measurement window, deduplicate imports |
| Together | One complete rehearsal | Upload → two real cuts → concrete revision → review/export → real observation → approved changed rule → subsequent changed edit |

## Gaps that must stay visible

- **External precedent research:** source footage inspection exists; reference URL ingestion and a bounded cited audience/creative-research result are not implemented on audited master.
- **Evidence bridge:** Instagram sync stores media insights, while Results learning uses campaign observations. Verify or build the explicit mapping using publication, local clip, account and window identities. Do not silently pool generic events or another profile's observations.
- **Follow-up trigger:** a three-day review needs publication timing, due work, fresh evidence collection and an evaluator. Current local scheduler needs the app running and does not implement this learning trigger. Missing/weak evidence must yield insufficient evidence.
- **Analyst automation:** performance recommendations are produced inside an agent production run; saving a learning proposal currently takes a supplied complete Direction. There is no standalone new-results-to-strategy analysis trigger.
- **Idempotency:** observation and export creation are not server-idempotent. UI disables duplicate submission and reconciles uncertain writes; durable keys are later backend work.
- **Live publication:** requires eligible connected account, exact approved clip, explicit enablement and reachable public HTTPS video URL. Local export does not supply public hosting.
- **Paid execution:** insights/preflight exist; creating, activating, pausing or spending on ads is not implemented.
- **Agent reliability:** a teammate branch has additional JSON/range/evidence-repair and caption fixes not present on audited master. Inspect/review and bring those changes into the shared code deliberately; branch existence is not tested proof on the intended model.

## Database decision

Keep the existing local SQLite database and files for this single-operator Mac MVP. Supabase is optional later for shared accounts, cloud persistence/auth and storage. A static hosted preview cannot run the local models, FFmpeg worker or a continuously running three-day collector. A later cloud worker needs durable storage, scheduling and account authorization independently of frontend hosting.

## Demo evidence

Record actual elapsed time, active human minutes, accepted outputs, revision count and direct processing cost with exclusions. Compare against a matched manual baseline before claiming savings. Historical analytics may demonstrate the loop when labeled; they cannot establish fresh causal lift. A local model's score is a production hypothesis, not business performance.

## Documentation state

The shared Google Doc's MVP tab now describes onboarding and Factory/Library/Results, retaining the earlier detail mockups. Software Factory has tracked suggestions for Product Description, onboarding/recovery requirements, the results follow-up boundary, the campaign navigation blueprint and a populated Results learning blueprint. These suggestions remain pending review; they are not silently approved requirements. WO4 remains in progress until verification and handoff. Current integrated upstream is master4966544; the earlier700c907 audit remains a dated source snapshot.
