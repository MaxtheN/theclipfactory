# Team mode implementation contract

Team mode is native to Clip Factory and inspired by the role/ledger patterns in
[memdoor](https://github.com/guregodevo/memdoor) and
[GVS5H](https://github.com/slee-persis/GVS5H). No upstream code is embedded and no
coding benchmark is claimed as marketing evidence.

## Product behavior

- Producer, footage analyst, creative strategist, editor, critic, and performance
  analyst are distinct fresh-context calls against a shared local model.
- Three model-download workers run independently of the heavy lane.
- A single heavy worker serializes inference/rendering on the target Mac. Logical
  collaboration does not mean six loaded models or parallel GPU inference.
- A durable local production ledger preserves context snapshots, tasks, evidence
  references, validated outputs, findings, revisions, timings, and clip lineage.
- Critique checks source context, claim support, captions, and duplicates. Missing
  evidence remains unknown. A model's pass result is not human approval.
- At most two correction cycles; repeated edit output stops as no progress. Invalid
  handoffs fail before rendering. Completed local outputs survive cancellation.
- Every output needs human review; team calls have no publish/spend tools. Existing
  external authorization gates remain authoritative.
- Restart marks interrupted work; no silent resumption or repeated external writes.
- Baseline and team comparisons use matching source/config snapshots, observed
  timings and creator feedback. No invented success/ROI or causal claims.

## API

Authenticated same-origin API, existing session/error conventions:

- Settings gain `production_strategy: "team" | "baseline"`, default `"team"`.
- `POST /api/videos/{video_id}/team {model_id:"qwen-small", revision_budget:2}`
  -> `{job: Job, run: TeamRun}` (202). Budget integer 0..2.
- `GET /api/team/runs` -> TeamRun[] (newest first).
- `GET /api/team/runs/{run_id}` -> TeamRun.
- `POST /api/team/runs/{run_id}/cancel` -> TeamRun. Queue cancellation is not
  immediately final for active work.
- `GET /api/team/comparisons?video_id=...` ->
  `{video_id, runs:[{id,mode,status,model_id,objective,elapsed_seconds,clip_ids,
  feedback,outcomes,resource_observations,comparable}], notes:string[]}`.
- Existing `POST /api/videos/{id}/produce {model_id}` records a baseline run when
  strategy is baseline and a team run when strategy is team; response stays Job.
- New `POST /api/videos/{id}/baseline {model_id}` always uses baseline for explicit
  comparison, returning Job. Source must not already have an active task.

TeamRun:
`{id,video_id,mode:"team"|"baseline",model_id,objective,status,job_id,
 revision_budget,revision_count,stop_reason,created_at,started_at,finished_at,
 elapsed_seconds,resource_observations,clip_ids,plan,context,permissions,tasks}`.

Run status: `queued|running|needs_review|failed|cancelled|interrupted`.
`needs_review` means local production finished, not approved or published.
Permissions always `{publish:false,ads:false}` for team work.

Task:
`{id,role,label,kind:"agent"|"tool",status,iteration,input_refs:string[],
 output:object|null,error:string|null,started_at,finished_at}`.
Task status: `queued|running|completed|failed|cancelled|skipped`.
Roles: `producer|footage_analyst|creative_strategist|performance_analyst|editor|
critic|transcribe|render|baseline`.
Inputs/outputs are untrusted text/data, rendered without executable markup.
Footage and edit references must include an observed frame within the range or
overlapping transcript speech; feedback and source metadata alone cannot ground
content. Saving changed team metadata invalidates critique and approval.
`POST /api/clips/{id}/team-review {}` queues an explicit single critic recheck
using the original run model/evidence; a passing recheck still requires approval.
Baseline `not_applicable` is explicitly distinct from unresolved team critique.
Critic output:
`{verdict:"pass"|"revise"|"unknown",findings:[{candidate_index,category,
 severity,evidence_refs:string[],message}],checks:{context,claims,captions,duplicates}}`.
Each check is `pass|fail|unknown`. Unknown/failed checks prevent release approval.
Clips gain `team_run_id`, `team_review_status`, and `team_findings`.

Fresh output generations must validate against bounded schemas. Ledger outputs
are inspectable summaries/artifacts, not hidden chain-of-thought. No shell,
publish action, remote model fallback, or generated executable code is accepted.

## Mac acceptance

Linux CI verifies orchestration with scripted model doubles and real FFmpeg.
Fresh MLX/Kokoro inference, native Cocoa/Keychain and throughput require target-Mac
acceptance. Packaged app must contain standalone inference_worker.py. The Mac
artifact is ad-hoc signed, not Developer-ID signed or notarized.
