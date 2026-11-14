# Results UI independent review

Reviewed the working changes to `Results.tsx`, `results-story.css`, and `resultsStory.test.tsx` against HEAD `8c13958`. Read-only product review; no product, protected Studio, or backend writes. Tests were not rerun concurrently with the owner.

## Verdict

No blocking findings in the reviewed diff.

- Posted clips and Insights use hidden mounted views, so changing the visible section does not reset strategist state or its callbacks.
- Accounts, manual results, and upgrades use the shared persistent native dialog. Closing does not discard form state. Visibility gates close dialogs when Results leaves view; Escape and focus restoration are supplied by `PanelDialog`.
- Results data polling remains controlled by screen visibility. Accounts polling now runs while its modal is open and refreshes when reopened; this does not change the worker or posting operations.
- The existing `#gf-accounts` and `#connections` entry points still open accounts when Results becomes visible. The one-time `#gf-accounts` hash clearing is preserved.
- Metric source labels, unknown values, demo labels, measurement windows, observation inputs, and next-experiment callbacks remain intact. Changes do not introduce posting or approval actions.
- Muted slate surfaces and restrained semantic up/down colors replace the previous decorative spectrum. Narrow layouts and reduced motion have explicit rules.
- The focused test update exercises the visible view switch, accounts Escape dismissal, manual dialog open/close, and return to posted clips.

## Remaining visual verification

Check one populated posted list and one populated Insights view in the running Mac/browser preview. In particular, verify long account names, demo labels, metric chips, and the shared modal scroll boundary at the user's current window size. DOM review cannot establish those pixel-level outcomes.

Optional future coverage: assert draft preservation across modal close/reopen and the two account hash entry points. The persistent DOM structure and retained hash effect support both in the reviewed code.
