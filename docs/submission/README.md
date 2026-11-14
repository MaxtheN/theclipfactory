# Submission preparation

**EVOLVE: 8090 AI Hackathon · checked November 14, 2026.**

The founder asked for repo documentation and submission copy to be refreshed. The
signed-in Chrome dashboard was inspected read-only. **No fields were saved, no
terms accepted and no project submitted. Leave the video blank until it is ready.**

## Deadline and requirements

The [official rules](https://evolve-8090.devpost.com/rules) state:

- Submit by **3:15 PM PT Saturday, November 14, 2026**. Code freeze is **3:30 PM PT**.
- Public source under MIT, with a root MIT LICENSE and accurate copyright notices.
- README must disclose libraries, APIs, AI/sponsor tools and pre-event work.
- Team of up to three; in-person presentation at the assigned slot is required.
- A short demo video is required for sponsor prizes and useful to judges. The
  current project-details form marks its video field required; no exact duration
  is specified on the rules page. Our two-minute cut is an editorial target.
- Theme fit is pass/fail: software must automate real building, testing, shipping
  or maintenance. Show the actual **builder work order → extension → tests →
  sample render → human review** path. A content workflow alone does not explain it.

## Current dashboard readback

The draft is `Marketing FSD`, showing **2/5 steps done** at inspection. Team members
are listed; project details/additional information are still incomplete. We prepared
the name **Growth Factory** and a 192-character pitch under the 200-character limit.

| Area | Observed state | Prepared material / remaining action |
| --- | --- | --- |
| Overview | Old name/tagline; thumbnail placeholder | [Field copy](fields.md); review name/pitch and choose thumbnail. |
| Project story | Blank | [Devpost story](devpost.md). |
| Built with | Blank | 17 proposed tags in [field copy](fields.md); form allows 25. |
| Try-it links | Blank | Public repo + qualified landing link prepared. |
| Video | Blank, required | Leave blank per founder instruction. Record/upload before submission. |
| Gallery | Empty | Actual Pearl sample-UI screenshot available; add builder proof and real clip capture. |
| Public repository | Blank, required | Team repository URL prepared; MIT license approved by founder. |
| Sponsor answers | Unselected | Composio + Vercel; ElevenLabs No; no ElevenLabs prize claim. |
| Finalization | Terms unchecked, not submitted | Team reviews/accepts terms and submits when ready. |

## Prepared repo materials

- [Field-ready copy](fields.md), [project story](devpost.md), [evidence ledger](evidence.md).
- [Demo script](demo-script.md), [video storyboard](video-storyboard.md), [judge Q&A](judge-qa.md).
- [Root README](../../README.md), [MIT license](../../LICENSE), [third-party notices](../third-party-notices.md).
- [Current handoff](../HANDOFF.md), [engine](../engine.md), [finish line](../finish-line.md), [roadmap](../product-roadmap.md).

## Before the team submits

- [ ] Review the final public narrative against the exact demonstrated revision.
- [ ] Verify the current GitHub Actions result; distinguish hosted CI from local passes.
- [ ] Record the builder's actual diff, checks and sample render; keep temp-clone / not-merged status visible.
- [ ] Review a fresh real clip for meaning, captions, audio, framing and timing. A rank score is not editorial approval.
- [ ] Capture any real-post evidence only after exact clip/caption approval; otherwise label publishing as implemented but not live-verified.
- [ ] Keep synthetic engagement and new unmerged demo work explicitly labeled.
- [ ] Add the uploaded video URL, final screenshots/thumbnail, tags and repo URL.
- [ ] Confirm rights to demo media, team details/eligibility and pre-event disclosure.
- [ ] Team reads/accepts the final terms and submits before the deadline.

## Ownership and revision discipline

The default branch is `master`; `kartik/backend-integration` is the working branch.
The UI merge was `5e6c6a0`. Use current source and commit readback rather than older
handoff snapshots. The shared local checkout has other active backend/demo work;
this documentation pass uses an isolated worktree and does not absorb unfinished
changes. No release, real post or paid action is authorized by this checklist.
