# Growth Factory design handoff

Current direction and navigation, refreshed 2026-11-14 after the `5e6c6a0` merge.
The earlier feature-branch-only / no README / no master restrictions and smoked
glass palette are historical and superseded by explicit founder instructions.

## Product and visual direction

Growth Factory is an AI growth department for Mac. Video and Instagram are the
first production line; its builder can turn an editing gap into a tested,
human-reviewed renderer extension. This is the concrete software-building-software
path for EVOLVE. Product and submission claims must follow actual evidence.

The founder approved **Pearl Studio**: calm warm paper, graphite typography,
restrained bronze, native system fonts and selective translucent chrome. Use
hierarchy, spacing and focused detail views instead of a wall of nested cards.
Glass is an accent in the sidebar, top bar and dialogs, not the whole canvas.

| Token | Value / role |
| --- | --- |
| Canvas | `#F2F0EB` |
| Pane | `#FCFBF7` |
| Sidebar base | `#EAE7E0`, subtle translucency |
| Ink | `#293237` |
| Secondary text | `#616A6E` |
| Border | `#DAD6CE` |
| Bronze | `#8B6946` |

Shared material tokens: `frontend/src/growth/material-tokens.css`. The last-loaded
`pearl-studio.css` resolves legacy palette/cascade rules. Keep dark actual-video and
phone-preview surfaces with white media overlays. Preserve semantic status colors,
keyboard focus and reduced-motion/transparency support.

## Current app structure

The only entry point is `GrowthApp`. Sidebar: **Factory, Library, Results** and
**Brand profile**. The earlier Make/Grow App and Advanced tools are removed.

- **Factory:** episodes / map; actual source/job status, upload, production handoff,
  five-phase map, run ledger and viewport-clamped picker.
- **Library:** clips, review wall and episodes; playback, exact review, confirmed
  discard/delete and retained-file explanations. Source maintenance locks while
  busy, stale, active or clearing.
- **Studio:** source/clip player and a focused review inspector. Technical/version
  evidence, production logs and posting use focused sheets. An exact clip version,
  agent critique, human approval and external publication remain distinct.
- **Results:** posted clips and Insights; account/tracking controls use focused
  dialogs. Organic evidence is observational; synthetic records remain labeled.
- **Brand profile:** local section rail and one summary pane; explicit Edit/Manage
  actions open persistent editors. Save appears only when dirty. Saving Style rules
  stays in context; navigation to Factory is an explicit action.
- **Engine & models:** Brand profile → Advanced, also directly through ⌘K. Runtime,
  model management, production defaults, narration and background jobs remain available.
- **Onboarding:** full-window brand setup with progress, focused form content and
  actual-save-driven launch handoff. Keep the shell fixed; long content scrolls in
  a bounded region. No fake network progress or repeated writes for animation.

## Repo and preview

Team repo: https://github.com/MaxtheN/theclipfactory . Default branch: `master`.
Working branch: `kartik/backend-integration`. Founder authorized integration to both
and subsequent documentation refresh. Fetch and merge current upstream history;
never force-push or overwrite another active worktree's changes.

Native production uses pywebview/WKWebView + authenticated loopback FastAPI, SQLite
and the built React/Vite bundle. Source start: `bash scripts/setup-mac.sh`, then
`.venv/bin/clip-factory`. [Full setup](development.md).

For an explicitly synthetic design preview, run `npm run dev:review` in `frontend`
and open `scripts/preview-interface.py` against that local URL. A custom port may
be selected with Vite arguments and the viewer's `--url`. The active Pearl review
server was port 5179 at handoff. HMR updates the viewer; the real app needs a
frontend rebuild and backend restart for respective source changes. Preserve user
drafts. Do not tunnel the local authenticated backend.

## Verification and next pass

UI merge evidence is in `.sw-factory/pearl-master-merge.md` and
`.sw-factory/pearl-studio-plan.md`. The full frontend suite now passes locally with
two workers (421 tests); hosted CI is checked separately. A sample UI screenshot,
unit tests or a successful build does not prove real clip quality or a post.

For a new UI change, check the affected journey, keyboard/focus, empty/error/dirty
states and actual text contrast. Test relevant behaviors; do not add tests that
merely copy CSS implementation. Keep publishing, source deletion, account scope,
lineage and uncertain-effect reconciliation intact.

Current live gates and approved submission copy are indexed in
[submission/README.md](submission/README.md). Ongoing backend scoring/re-cut/demo
work is excluded from published claims until its exact reviewed commit lands.
