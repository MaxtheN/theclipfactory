# Running Growth Factory on this Mac

Two current windows serve different purposes:

- **Growth Factory — New Live Flow:** Vite5179 with labeled sample data and live design updates.
- **Growth Factory — Real Local Engine:** authenticated local API, saved campaigns, installed models and real All-In media. This is the working production/review instance.

Use Workspace → New workspace for onboarding. Use Quick actions → Refresh workspace to load work created by an external test, then select **All-In · What anonymous sourcing actually tells us** to review the substantive captioned draft. Watching/listening and editorial approval are still required.

A fresh development bundle is at `dist/Growth Factory.app`, with `dist/growth-factory-mac-arm64.zip`. Assets, ad-hoc code signature and an isolated native authenticated-window smoke passed. The bundle is not a notarized public release. Models are installed separately; the current verified runtime/demo data lives outside git.

`dist/Open Growth Factory Demo.command` launches that bundle with this Mac's verified media-tool PATH and existing demo state. Close the currently running Real Local Engine before using that launcher, so two workers do not open the same demo store. The launch helper is specific to this Mac; a normal new-user app launch uses its own local data and setup.

The shared hosted preview is https://growth-factory-review-8090.vercel.app . It uses explicit sample fixtures and cannot run the Mac's models or render its local video. The deployed HTML hash matches the reviewed fixture build.

## Required later

- Sign/notarize and validate the public installer, including dependable media-tool setup, model setup and one-running-instance behavior.
- Add external precedent ingestion and bounded cited creative research.
- Map exact published clip/account/window insights into campaign evidence; deduplicate observations.
- Persist and run the three-day collection/evaluation trigger; show insufficient evidence when appropriate.
- Add authorized publication/public media hosting; keep paid activation/spending separate from existing preflight.
- Run a matched effort/cost benchmark and collect editorial acceptance and later audience outcomes.
