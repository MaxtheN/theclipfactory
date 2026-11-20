# Library and clip review

**Library** lists every episode and the clips made from it. Open a clip to review it in [Studio](studio.md). If you have no footage yet, **Add footage** takes you to Factory.

## Review states

- **Needs review**: a finished clip waiting for you. The factory's own checks passing does not approve it.
- **Approved**: you approved this exact revision. Approval is recorded against that revision, so editing the clip creates a new revision that needs approval again.
- **Illustrative edit**: a sample shown in preview mode, not a real clip.

Approving, exporting and posting are three separate decisions. Approving does not export or post anything.

## Exporting

**Export** saves the approved file to a folder you choose. You get the exact file you reviewed: the same revision, with the checksum shown in the clip details. Every plan can export. Free makes up to 20 clips a month, and posting from the app needs Pro (see [Plans and billing](plans.md)).

## Clip evidence

Each clip's details show its evidence: the scenes and transcript lines it was cut from, technical checks (duration, captions, framing), critic findings, version history and timings. Two things to keep in mind when reading them:

- **Processing time** is the time the factory spent working on that clip. It does not include time waiting in the queue or the time you spent reviewing.
- **Direct render cost** (local compute, plus any cloud model calls) is not the fully loaded cost of a usable clip. It leaves out your review time, the clips you rejected and your equipment. Don't quote it as cost per published asset.

Comparisons between engines (for example swarm and Deep edit on the same episode) are only shown as comparable when they used the same source and settings. The app does not compute a success rate or ROI for you.
