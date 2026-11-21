# Working on Growth Factory (read this first)

Growth Factory is a desktop app (Mac, Windows, Linux) sold as a self-serve subscription: agents turn long videos into
short captioned clips on the user's computer, post approved clips to seven platforms, and learn from the results.

This file is the entry point for any agent or developer picking up the repo. Then read, in order:

1. [docs/handoff/README.md](docs/handoff/README.md): the whole system as it is on `master`, with a code map.
2. [docs/handoff/outstanding-work.md](docs/handoff/outstanding-work.md): what is left, in priority order.
3. [docs/handoff/launch-checklist.md](docs/handoff/launch-checklist.md): the owner-only steps to start selling.
4. [docs/architecture.md](docs/architecture.md): five diagrams of the system (Mermaid).

Specs (requirements, blueprints, work orders) live in the
[Growth Factory Software Factory project](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319).
Work orders are referred to as `WO-N`.

## Set up

```sh
uv venv .venv && uv pip install --python .venv/bin/python -e '.[test]'   # or: python -m pip install -e '.[test]'
(cd frontend && npm ci)
# Optional: Deno 2 for supabase/functions, the Supabase CLI for deploys.
```

Run the app: `bash scripts/setup-mac.sh` (or `setup-linux.sh`, or `scripts\setup-windows.ps1`), then
`.venv/bin/clip-factory`. UI only, with sample data and no engine:
`cd frontend && VITE_REVIEW_PREVIEW=true npx vite --port 5179`.

## Verify before you push

| What changed | Run |
|---|---|
| Python (`clip_factory/`, `scripts/`) | `.venv/bin/python -m pytest -q -p no:cacheprovider tests scripts/tests` and `.venv/bin/python -m ruff check clip_factory scripts` |
| Frontend (`frontend/`) | `cd frontend && npx tsc --noEmit -p . && npx vitest run && npm run build` |
| Cloud functions (`supabase/functions/`) | `cd supabase/functions && deno fmt --check _shared/ posting/ billing/ && deno lint _shared/ posting/ billing/ && deno test --allow-read posting/ billing/` |
| Website (`landing-page/`) or the guide (`docs/guide/`) | `cd landing-page && npm run generate && npm run check && npm test` |

CI (`.github/workflows/ci.yml`) runs all four on every push and PR: `test` on Ubuntu, macOS and Windows,
`posting-server`, and `website`. A Drift Bot check compares the change with the specs; it does not block, but read it.
`tests/test_faces.py` needs libEGL and is usually deselected locally. Known flaky: the onboarding "Quick actions"
Vitest and `tests/test_learning.py` under load; rerun once before investigating.

## Conventions

- **Branches:** `8090/<wo-N or chat>-<slug>-<6 random chars>`, from `master`.
- **Commits:** titled `Area: description`, for example `Website: pricing page`.
- **PRs:** one per work order, titled `Area: description (WO-N)`. Merge with a merge commit (`gh pr merge N --merge`)
  once CI is green. Then set the work order to Completed in the Software Factory.
- **Teammates' PRs:** PRs by other authors (currently #42 and #47) are theirs. Do not push to or merge them unless
  asked.
- **Writing:** user-facing text is plain, sentence case and says what to do. No invented capability, metric or
  testimonial: the site and app only claim what the code does.
- **Secrets:** never print, commit or bundle a secret. The app ships only the publishable Supabase key
  (`clip_factory/cloud_config.json`). Stripe and Zernio keys exist only as Supabase function secrets. Users' API keys
  live in the OS key store.

## Change recipes (things that must move together)

- **Plans or prices:** change them together, or parity tests fail:
  - `supabase/functions/_shared/plans.ts`, `clip_factory/billing.py` (`PLANS`) and `landing-page/plans.json`;
  - the Stripe prices (owner);
  - then run `npm run generate` in `landing-page/`.
- **Guide page added or renamed** in `docs/guide/`: update all of these, or `tests/test_help_api.py` and the site tests
  fail:
  - `docs/guide/README.md` (table);
  - `clip_factory/help_api.py` (`PAGES`);
  - `frontend/src/growth/guideLinks.ts` (`GuidePage`);
  - `DOCS_NAV` in `landing-page/build.mjs`;
  - then regenerate the site.
- **Any guide edit:** run `npm run generate` in `landing-page/` and commit the output; CI's `website` job fails while
  it is stale.
- **Headings the app links to** (`guideLinks.ts` anchors): renaming one breaks Help links; tests check them.
- **System shape changes:** update `landing-page/site/diagrams.mjs` and `docs/architecture.md` together.
- **New cloud table:** add a migration in `supabase/migrations/` with row-level security, plus a probe in
  `supabase/tests/` that ends `...probes passed; synthetic rows rolled back.`
- **Billing return paths** (`/billing/success.html` and the others) are used by `supabase/functions/billing/handler.ts`
  and tested by the site tests. Move both or neither.

## Product rules that code must keep

- Nothing is exported, posted or turned into a Style rule without the user approving that exact revision.
- Unreported metrics are unavailable, never zero. Demo and simulation data is labelled and never mixed into real
  results.
- Uncertain post outcomes are reconciled by external id, never blindly retried.
- A downgrade never deletes anything; limits only block creating more.
- Local first: name anything that leaves the computer before it goes.
- No public installer link until a signed release exists (WO-38).
