# Studio

**Studio** is where you review, approve and fine-tune clips. Open it from Factory or from a clip in Library.

## Review this clip

The clip strip reads "Review N clips · best first". Weaker clips are under **Below the bar (N)**; open the group to see them. Every clip shows its state (**Needs review** or **Approved**) and plays the exact rendered file.

- **Approve** records approval of that exact revision. It does not export or post anything.
- **Request a change** asks for another version. Say what would make it better; the reason is kept, used for the new version, and read by the [Factory builder](results.md#factory-upgrades).
- **Export** saves the approved file. Posting is a separate step (see [Posting](posting.md)).

If a clip was edited after you approved it, the edit becomes a new revision and needs approval again. Saving changes to a Deep edit clip clears its critic result too, so the critic must check it again before you can approve.

## Fine-tune

**Fine-tune** changes one clip without starting over:

- **Start / End (seconds):** move the range. The source preview shows what is around it.
- **Opening treatment:** how the clip opens, including an optional cold open (a short teaser from later in the clip, set with Cold open start and end).
- **Crop focus:** where the vertical frame sits.
- **Include captions:** burn captions in or leave them out.

Each fine-tune makes a new revision linked to the one it came from, so the history is never overwritten.

### Deep edit

**Deep edit** runs the slower team engine on this episode (see [Factory and episodes](factory.md#deep-edit)). **Correction budget** sets how many correction rounds the critic may ask for, from 0 to 2. Use it for a few clips that matter; use Find clips for volume.

### Recheck

A Deep edit clip can be rechecked once by the critic, using the original run's model and evidence. A passing recheck still needs your approval.

## Finding clips from Studio

When no clip is selected, Studio shows **Find clips** for the current episode: **Production mode** (whole episode, best first; or Deep edit), the installed vision model, a summary of your goals and brief, and "What should the agents look for? (optional)". The note is a hint for this run only; it cannot override your boundaries or approved Style rules.
