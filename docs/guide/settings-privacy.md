# Settings and privacy

**Settings** has seven sections: Device and runtime, Models, Accounts and connections, Plan and billing, Privacy and storage, Background jobs, and About.

## Where your data lives

Your episodes, clips, transcripts, Style rules, results and ledgers are stored **on your computer**, in the app's data folder. **Settings → Privacy and storage → Data folder** shows the exact path. Back it up like any other folder.

There is no general cloud copy of your work. Signing in links your plan and your connected posting accounts; it does not upload your library.

## What uses the internet

| Feature | Goes online? | What is sent |
|---|---|---|
| Adding, transcribing (local), finding and editing clips with local models | No | Nothing |
| Downloading models | Yes | Download requests only |
| Cloud models (OpenRouter) | Only with your key | Text, plus still frames if you allow them ([details](models.md#exactly-what-is-sent-where)) |
| Cloud speech (Groq) | Only if turned on | The episode's audio |
| Brand research from a website | Yes | Fetches your public website |
| References from an MP4 link | Yes | Downloads that file only |
| Signing in, plan and billing | Yes | Your email; payment is handled by Stripe |
| Connecting accounts and posting | Yes | The approved clip, its caption and the accounts you chose |
| Results measurement | Yes | Requests for your posts' metrics |
| Opening this guide | Yes | Opens the guide in your browser |

Payments are handled entirely by Stripe; card details never pass through the app.

## Background jobs

**Settings → Background jobs** lists queued and running work: transcriptions, clip runs, renders, Strategist runs and model downloads. Work interrupted by a restart is shown as interrupted and is never restarted silently. **Activity** (⌘K / Ctrl+K) shows the same work plus scheduled and overdue posts.

## Device and runtime

This section shows your computer's memory and GPU, whether Ollama and the speech runtime are ready, and what each feature needs. If something cannot run, it says why and what to do.

## About

The app version and platform, for support requests. Email [jamesbodebiyi@gmail.com](mailto:jamesbodebiyi@gmail.com) with them if something goes wrong.
