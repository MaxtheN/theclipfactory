# Models and AI settings

Growth Factory's agents need a language model that can look at still frames. You can run one on your computer, use a cloud model with your own key, or mix the two. Everything is in **Settings → Models**.

## Local models (private, free to run)

Local agents run through **Ollama**, a free app that runs models on your computer. If it is missing, **Get Ollama** links to the download. Then the app offers the model to download.

| Model | Download | Needs | Use |
|---|---|---|---|
| Qwen3-VL 4B Instruct (**recommended**) | about 3.3 GB | 12 GB RAM, or 8 GB RAM plus an NVIDIA GPU with 5 GB VRAM | Everything, including the Strategist, brand research, references and post copy |
| Qwen3-VL 2B Instruct | about 1.9 GB | 8 GB RAM, or 3 GB VRAM | Clip production only |

With under 8 GB of RAM no local model fits: use a cloud key, or do the work by hand. Ollama listens only on your own computer, and the model is unloaded after each task to free memory for transcription and rendering.

Before each heavy call the app checks that at least 6 GB of memory is free (or the model's size plus 3 GB). If other apps are using it, the task waits instead of slowing your computer to a crawl.

### Speech

| Computer | Local speech | Runs on |
|---|---|---|
| Apple Silicon Mac | MLX Whisper large-v3-turbo | Apple GPU |
| Windows or Linux, x64 | faster-whisper with Whisper large-v3-turbo | NVIDIA GPU if present, otherwise the CPU |
| Intel Mac, ARM Windows or Linux | not offered | use cloud speech or import a transcript |

Setup downloads about 3 GB once; after that, transcription works offline. **Cloud speech (Groq)** is optional: when it is on, the episode's audio is sent to Groq for transcription, and the app tells you before it does.

## Cloud models (fast, a few cents)

Add an **OpenRouter** key to use Anthropic's Claude models:

- **Claude Haiku 5.5** (default, "Fast"): under 1¢ per read.
- **Claude Sonnet 5.5** ("Quality"): about 20 times the price of Haiku.

You pay OpenRouter directly; Growth Factory adds nothing to the price. **Cloud spend so far** shows the total cost and number of calls, using the cost OpenRouter reports for each call (estimated from token counts when it does not report one).

## Exactly what is sent where

With a key saved, these tasks use the cloud model **by default**. Each one sends **text only**:

| Task | What is sent |
|---|---|
| Brand research | Your brand details and the text of your public website, if you gave one |
| Post copy | The clip's transcript lines, hook and your brief |
| Reference patterns | Text descriptions of a reference video's frames and captions, made on your computer |
| Strategist ideas | Tags, hooks and metrics from your measured posts |

These are **off unless you turn them on**:

- **Use cloud model for clip agents too:** clip production sends transcript text and descriptions of frames, written on your computer.
- **Also send still frames:** clip agents also see a few still images from the episode. Off means text only.
- **Fall back to local if the key fails:** without this, a failed cloud call stops and tells you, rather than silently switching models.

Raw video and audio are never sent to the model providers. The only audio that leaves your computer is cloud speech, if you turn it on.

With no key saved, or with the provider set to local, everything stays on your computer.
