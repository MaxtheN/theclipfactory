# Questions and answers

Short answers to the questions people ask before and after they install. Each answer links to the page with the detail.

## Which computers does it run on?

Mac, Windows and Linux. Local speech runs on Apple Silicon Macs and on x64 Windows or Linux computers; on an Intel Mac or an ARM Windows or Linux computer, use cloud speech or import a transcript (see [Models and AI settings](models.md#speech)). You also need FFmpeg with caption support, and enough free disk space for your episodes and the one-time speech model download (about 3 GB).

## Is there an installer?

Not yet. Signed and notarized installers for Mac and Windows, and a Linux AppImage, come with the first signed release. Until then, the [download page](https://growth-factory-landing.vercel.app/download) has a setup script for each system that installs from source in a few commands.

## Does my footage leave my computer?

Not unless you choose a feature that needs it. Episodes, clips, edits and results are stored on your computer. Cloud models receive the text they need (and still frames only if you allow it), cloud speech receives the episode's audio, and posting uploads the approved clip and its caption. The app says which before it sends anything. See [Exactly what is sent where](models.md#exactly-what-is-sent-where) and [What uses the internet](settings-privacy.md#what-uses-the-internet).

## Do I need an AI subscription?

No. Local models are free to run on a capable computer. Cloud models are optional and faster; you pay OpenRouter (and Groq, for cloud speech) directly with your own key; the default model costs under 1¢ per read. These costs are separate from your Growth Factory plan (see [Cloud models](models.md#cloud-models-fast-a-few-cents)).

## Which platforms can it post to?

TikTok, Instagram, YouTube, Facebook, LinkedIn, X (Twitter) and Threads, on the Pro and Business plans. Each account signs in on the platform's own page; Growth Factory never sees your password. On Free, export approved clips and post them yourself (see [Posting](posting.md)).

## Does it post without asking me?

No. Only a clip you approved can be exported or posted, and approval is for that exact revision. A scheduled post goes out only while the app is open; a time missed while it was closed waits for you instead of posting late (see [Missed schedules](posting.md#missed-schedules)).

## What do the plans cost?

Free is $0 with 1 brand and 20 clips a month. Pro is $24 a month ($19 a month billed yearly) with 3 brands, unlimited clips, posting and 3 connected accounts. Business is $200 a month ($160 a month billed yearly) with 15 brands, 30 connected accounts and factory upgrades. See [Plans and billing](plans.md).

## What happens if I cancel or my payment fails?

Cancelling takes effect at the end of the period you paid for. Nothing is ever deleted: your brands, clips and results stay, and only creating more than the plan allows is blocked. A failed payment shows **Fix payment** in Settings → Plan and billing (see [Payment problems](plans.md#payment-problems)).

## Does it work offline?

Yes, apart from features that need the internet (cloud models and speech, posting, measuring results, brand research from a website, downloading models). The app keeps your plan for up to 7 days from its last successful check, then works as Free until it can check again (see [Offline](plans.md#offline)).

## Can the numbers in Results be trusted?

They are real platform numbers, but a handful of posts cannot prove why one did better than another. The Strategist calls its findings observations and shows the evidence behind each one (see [What results can and cannot prove](results.md#what-results-can-and-cannot-prove)).

## How do I get help?

Open **Help** in the app, or email [jamesbodebiyi@gmail.com](mailto:jamesbodebiyi@gmail.com). Include what you clicked, what you expected and what happened. **Settings → About** shows the version.
