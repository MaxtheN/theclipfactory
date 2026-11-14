# 2-minute submission video storyboard

Format: 16:9 screen recording of the real app plus a few insert shots, with founder voiceover. Burned-in captions throughout. Any synthetic screen gets a persistent on-screen tag: **SIMULATION — synthetic data**.

| # | Time | Shot | On-screen caption | VO |
|---|---|---|---|---|
| 1 | 0:00–0:08 | Close-up of the notebook sketch, slow push in on "what could work? Double down" | *The analytics tab is where learning stops.* | "Every podcast has a dozen great clips buried in it. And when clips do go out, nobody turns the numbers into the next edit." |
| 2 | 0:08–0:15 | App launch, Factory screen, the channel name | **Growth Factory** · a marketing team on your Mac | "So I built a marketing team that runs on my Mac and learns from my own posts." |
| 3 | 0:15–0:28 | Drag a full episode onto **Add episode**. The stage tracker runs Listen → Watch → Pick moments. | Local: MLX Whisper · Qwen3-VL 4B · FFmpeg | "Drop in a full episode. It transcribes locally, and a vision model watches every scene, not just the transcript." |
| 4 | 0:28–0:40 | *What the factory saw* storyboard, scenes with timestamps. Zoom on a scene ID. | Models describe. Code measures. | "Agents cite scene IDs. The code computes the timestamps, so clips can't drift to moments that don't exist." |
| 5 | 0:40–0:55 | Agent ledger: producer → footage analyst → strategist → editor → critic, with handoffs and findings | One shared local model · strict schemas · ≤2 revisions | "A producer, footage analyst, strategist, editor and critic hand off through strict schemas. The critic checks every claim against what was actually said." |
| 6 | 0:55–1:05 | Big 9:16 player with a captioned clip. Click **Approve**, and the checksum appears. | You approve the exact file. | "A critic's pass isn't approval. I approve the exact file." |
| 7 | 1:05–1:20 | Results: verified Instagram account, then the tracked post mapped to the approved clip, then the metric snapshot | Real account · read-only · I post, then confirm which clip | "I post it myself, then tell the app which clip it was. Three days later it reads the real numbers through Composio. Read-only, never summed, unknowns stay unknown." |
| 8 | 1:20–1:38 | **What we've learned**: account baseline → experiment (hook before → after, cited snapshot) → rendered variant (Unapproved badge, lineage) → proposed Style rule | One change. Cited evidence. Or it abstains. | "The analyst compares the post with my own account's baseline and changes exactly one thing, or says it doesn't know. Then it renders the new version and proposes a rule I can approve." |
| 9 | 1:38–1:48 | Strategist panel with the **SIMULATION** banner visible: beliefs and confidence bars, explore/exploit split | **SIMULATION — synthetic data** · Strategist (in progress) | "Next is a Strategist that tracks what's working with real confidence math. Shown here on synthetic data so you can see it think." |
| 10 | 1:48–1:58 | Back to the sketch, right page: Paid Ads → formats → ROAS → change format | Next: brand line · real A/B splits · YouTube · TikTok | "Then the brand line: paid A/B splits, where 'what worked' becomes causal. Then YouTube and TikTok." |
| 11 | 1:58–2:00 | Logo card | **Growth Factory** · 8090 EVOLVE | "Growth Factory. Make it, measure it, change one thing." |

## Production notes

- Record every app shot on real data. For the snapshot shot, if **Measure now** was used, keep the `demo_override` badge in frame. Don't crop it out.
- No metric counts on screen implying growth. Blur or keep small any absolute numbers that aren't the point of the shot.
- Don't show the Composio key, the Settings key field, or the Supabase project ID.
- Shot 9 must keep the SIMULATION banner visible for its whole duration. If the Strategist UI isn't stable, replace the shot with a static diagram of the three layers, labelled "in progress".
- Music: low, no lyrics. Total runtime ≤ 2:00.
