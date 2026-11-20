# Your first clip

Seven steps, about 20 minutes plus processing time. You need one long video on your computer (an MP4 or MOV works) and, for automatic clip finding, a local model or a cloud key (see [Models and AI settings](models.md)).

## 1. Tell the app about your brand

The first launch asks for your brand or show name, who it is for, and its voice and boundaries (topics or words to avoid). This is the **Brand profile**. Every agent reads it, so a sentence or two of real detail beats a long list. You can change it later in **Brand profile → Brand & voice**.

## 2. Add an episode

In **Factory**, choose **Add episode** and pick the video file. The app copies it into its own storage and confirms when the copy is complete; it does not show a guessed upload percentage. Nothing is uploaded anywhere.

If you already have a transcript (SRT, VTT or JSON, up to 2 MB), import it to skip transcription. Otherwise the app transcribes on your computer with Whisper once the speech model is installed.

## 3. Pick a clip style

The agents start only once a clip style (your **Style rules**) is approved. The first time, the app proposes rules from your brand: hook style, length, captions, framing. Read them, edit anything that is not you, and choose **Approve**. Every later clip follows the approved version until you approve a new one.

## 4. Find clips and watch the Factory map

Choose **Find clips** on the episode. The **Factory map** opens and shows each station as it works: watching the footage, scouting moments, editing, captioning, self-checking and rendering. The map is a window onto real jobs; closing it does not stop them. Long episodes take a while because one heavy task runs at a time (see [Factory and episodes](factory.md#one-heavy-worker)).

## 5. Review and approve a clip

Open the episode's clips in **Studio** (from Factory, or from **Library**, which lists every episode and its clips). The strip at the top reads "Review N clips · best first". Clips below the quality bar are kept under **Below the bar**, not deleted. Play the exact file and check the hook and captions. Then:

- choose **Approve** to record approval of that exact revision;
- use **Fine-tune** to change the range, hook, captions or framing (this makes a new revision, which needs its own approval); or
- choose **Request a change** and give a reason. The reason also teaches the factory.

Approving does not export or post anything; those are separate steps. Only approved clips can be exported or posted.

## 6. Post it

Connect an account once in **Settings → Accounts and connections** (posting needs the Pro plan). Then post the approved clip now or schedule it. Scheduled posts go out while the app is open; a time missed while it was closed waits for you instead of posting late (see [Posting](posting.md#missed-schedules)). On the Free plan, export the clip and post it yourself.

## 7. Read Results

After a few days, **Results** shows the views and engagement of tracked posts against your account's usual numbers. Once there are enough measured posts, the **Strategist** names patterns ("question hooks tend to beat this account's median views") and may propose a Style rules change for you to approve. These are observations, not proof; read [what results can and cannot prove](results.md#what-results-can-and-cannot-prove) before acting on them.

That is the loop: footage in, clips reviewed by you, posts measured, rules refined by you.
