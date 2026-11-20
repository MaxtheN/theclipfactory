# Factory and episodes

**Factory** is where footage comes in and clip production starts.

## Adding an episode

**Add episode** copies a video file into the app's own storage. The screen confirms two separate things: the copy finished, and the episode is attached to your brand. There is no guessed upload percentage, because nothing is uploaded; the file stays on your computer.

### Transcripts

Clips and captions are cut at sentence ends, so every episode needs a transcript.

- **On your computer.** Once the speech model is installed (Settings → Models), the app transcribes locally with Whisper: MLX Whisper on Apple Silicon Macs, faster-whisper on Windows and Linux (x64). After setup this works offline.
- **Import one.** **Import transcript** accepts SRT, VTT or JSON up to 2 MB. Importing does not need Whisper, and your draft is unchanged if the file is rejected.
- **Cloud speech (Groq).** On computers where local speech is not offered (Intel Macs, ARM Windows or Linux), you can turn on cloud speech. The episode's audio is then sent to Groq for transcription. The app says so before it sends anything.

## Find clips

**Find clips** starts agent production for the episode. A one-line summary of your brief (goal · call to action · avoid) is shown with **Edit brief**, so you can check what the agents will aim for. You can also add a note on what to look for; it is treated as a hint, never as an instruction that overrides your boundaries.

By default the **swarm** covers the whole episode, roughly one clip per minute of footage. It then:

1. ranks the clips best first;
2. applies a quality floor;
3. merges clips that are near-duplicates of each other;
4. keeps weaker clips under **Below the bar** in Studio. They are not deleted, and you can still open and approve them.

### Deep edit

For a few clips that matter, Studio → Fine-tune → **Deep edit** runs the slower **team** engine. Separate roles (producer, footage analyst, creative strategist, editor, critic and performance analyst) each work in a fresh context, hand over checked outputs, and the critic checks the result. The team makes at most two correction rounds and stops early when an edit makes no progress.

Team output still needs your review. A critic pass is not approval: a check that failed or could not be decided ("unknown") blocks approval until you resolve it. The team has no permission to post or spend money.

## One heavy worker

The agents are separate steps, but they share one model on your computer. **One heavy worker runs at a time**: inference and rendering are queued and run one after another, not in parallel. That is why a long episode takes a while, and why opening a second job makes it wait rather than slowing both down. Model downloads run separately and do not block the queue.

If the app quits or restarts while work is running, that work is marked **interrupted**. It is never silently restarted, and nothing external (a post or a cloud call) is repeated on its own. Start it again when you are ready. Output that already finished is kept, including output from a run you cancelled.

## The production ledger

Every run keeps a local ledger: the inputs each step saw, the evidence it cited (scene IDs, frames and transcript lines from inside the clip), what it produced, findings, revisions and timings. It is a record of what happened, not the model's hidden reasoning. Open it from the clip's details in Studio.

Footage and edit choices must cite something observed inside the clip's range: a frame, or speech that overlaps it. Feedback and file names alone cannot justify a clip. When evidence is missing, the app says "unknown" instead of guessing.
