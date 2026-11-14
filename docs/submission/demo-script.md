# 3-minute live demo script

Rule for the whole demo: say "real" only about real things. Anything synthetic is on screen under a SIMULATION banner, and you say the word out loud.

## Pre-demo checklist (T-30 min)

- [ ] **Memory.** Quit Chrome, Slack, Docker, IDEs and any other Ollama or MLX processes. In Activity Monitor, memory pressure should be green, with at least 6 GiB free plus the model weights plus 3 GiB. The admission guard holds below max(6 GiB, weights + 3 GiB). <!-- docs/runtime-resource-policy.md -->
- [ ] Plug in power. Turn on Do Not Disturb. Disable sleep.
- [ ] **App on real data.** Open the channel with a real episode already imported and storyboarded, and at least one approved, rendered clip with a checksum.
- [ ] **Signed in** with the Supabase email+password account. Composio key present (Settings shows the Keychain key).
- [ ] **Verified Instagram account bound** (e.g. @kartik._builds), visible in Results.
- [ ] **A real post tracked and mapped to its exact approved clip**, ideally published more than 3 days ago so a real scheduled snapshot exists. If not, confirm the **Measure now (demo — window not elapsed)** button is available on that publication.
- [ ] One learning experiment already completed, with a rendered unapproved variant, in case the live analyst run is held.
- [ ] Warm Ollama `qwen3-vl:4b` with one trivial run so the first call isn't a cold load.
- [ ] Backup screen recording of the full flow, one tap away.
- [ ] A second episode or a 90-second clip queued for the live "Find clips" beat. Use something short. Do not live-run the full 85-minute source.

## Beat sheet

| Time | On screen | Say | Real / Sim | Fallback |
|---|---|---|---|---|
| 0:00–0:20 | Notebook sketch, then the app's Factory screen | "Every podcast has a dozen great clips that never get posted, and when clips do go out, nobody turns the numbers into the next edit. Growth Factory is a marketing team on your Mac that makes the clips *and* learns from your own posts." | — | — |
| 0:20–0:50 | Factory: click **Add episode** / **Find clips** on the short source. The stage tracker runs Listen → Watch → Pick moments → Render. Open *What the factory saw*. | "Everything runs locally: Whisper transcribes, a 4B vision model watches every scene, and FFmpeg measures and renders. The models describe and the code measures. Clip timestamps come from scene IDs the agent cites, never from numbers it makes up." | REAL | **Memory hold:** the guard shows "held: memory pressure". Say: "That's on purpose. It refuses to run rather than crash your laptop." Then cut to the prepared episode that already has clips. **Model/provider error:** open the Production log, show the recorded error, and move to the prepared clips. |
| 0:50–1:20 | Studio review: big player on a prepared clip. Open **Details** to show the agent ledger: footage analyst → strategist → editor → critic, with findings and checksum. | "A team of agents (producer, footage analyst, strategist, editor, critic) hand off through strict schemas. The critic checks claims against what was actually said. Its pass is *not* approval. I approve this exact file." Click **Approve**. | REAL | Player stalls: open the clip in Library → Clips instead. |
| 1:20–1:50 | Results: the verified Instagram account, then the tracked post with its mapping to the approved clip and its metric snapshot. | "This is my real Instagram, verified through Composio with read-only access. I posted this clip myself, and the app knows which approved file it was because I confirmed it. Three days later it saved this snapshot. These are real numbers from the provider, never summed, and unknowns stay unknown." | REAL (badge says `demo_override` if Measure now was used) | **Composio/provider error:** the error banner is bounded, and no provider text leaks. Say "provider read failed, nothing fabricated" and show the existing saved snapshot. If you use **Measure now**, say: "This button only skips the wait. The read is real and the record is badged as early." |
| 1:50–2:25 | Results → **What we've learned**: the account baseline, the experiment (hook before → after, cited snapshot ID, limitations), the rendered variant (unapproved, with parent/experiment/hash lineage) and the proposed Style rule. | "The analyst compares this post with *my own* account's median. It can change exactly one thing, the hook or the duration, and it must cite the snapshot, or it abstains. Here it rewrote the hook, and the app actually rendered the new version. It's unapproved, and the matching Style rule waits for me." | REAL (prepared earlier if the live analyst was held) | **Analyst held or timed out:** show the completed prepared experiment and say "this one ran yesterday on the same code path". **Analyst abstains:** that's a feature. Read its reason out loud. |
| 2:25–2:45 | The Strategist panel under the **SIMULATION** banner: beliefs with confidence, the explore/exploit portfolio. | "This is the next layer, still in progress: a Strategist that tracks beliefs like 'question hooks beat my baseline' with deterministic confidence, and keeps 25% of clips exploring. This is a **simulation on synthetic data**, labelled as such, so you can see how it reasons before it has enough real posts." | **SIMULATION** | If the panel isn't merged or stable at demo time, skip it and say it in one line over the Results screen. |
| 2:45–3:00 | Back to the sketch, right page: the brand line. | "Next is the brand line: paid ads, real A/B splits, ROAS by format. That's where 'what worked' becomes causal instead of observational. Today: your podcast, your Mac, your numbers. Thank you." | — | — |

## Lines never to say

- "It grew my audience", "went viral", "X% lift", or "ROAS". None of that is measured.
- "It posts for you." Publishing is human. Composio is read-only.
- "Six agents in parallel." There is one shared model on a serial heavy lane.
- "Strategist is shipped." It is in progress unless that has changed by demo day.
