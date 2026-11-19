# Third-party software, models and services

Submission inventory reviewed 2026-11-14 against the repository manifests, installed package metadata and the primary sources linked below. The project license applies to Growth Factory's own code; dependencies, model weights, external media, fonts and hosted services retain their own licenses or terms.

This is the direct-dependency and principal-tool disclosure for EVOLVE. It is not an exhaustive binary-distribution notice bundle. Frontend transitive versions are recorded in [`frontend/package-lock.json`](../frontend/package-lock.json); Python version ranges and optional extras are in [`pyproject.toml`](../pyproject.toml). A release must retain the actual dependency license/copyright files and audit the exact packaged artifacts. Python dependencies are not fully locked by this inventory.

## Application dependencies

The following license identifiers were checked in installed package metadata. Repository links lead to the respective upstream license and copyright notices.

| Python package | Use | License | Upstream |
|---|---|---|---|
| FastAPI | Local HTTP API and validation | MIT | [fastapi/fastapi](https://github.com/fastapi/fastapi) |
| Uvicorn | Local ASGI server | BSD-3-Clause | [Kludex/uvicorn](https://github.com/Kludex/uvicorn) |
| python-multipart | Media upload parsing | Apache-2.0 | [Kludex/python-multipart](https://github.com/Kludex/python-multipart) |
| HTTPX | Provider and download requests | BSD-3-Clause | [encode/httpx](https://github.com/encode/httpx) |
| certifi | CA certificate bundle | MPL-2.0 | [certifi/python-certifi](https://github.com/certifi/python-certifi) |
| platformdirs | Platform-specific data locations | MIT | [tox-dev/platformdirs](https://github.com/tox-dev/platformdirs) |
| keyring | Native credential storage | MIT | [jaraco/keyring](https://github.com/jaraco/keyring) |
| huggingface-hub | Opt-in model downloads | Apache-2.0 | [huggingface/huggingface_hub](https://github.com/huggingface/huggingface_hub) |
| psutil | Memory/resource probes | BSD-3-Clause | [giampaolo/psutil](https://github.com/giampaolo/psutil) |
| pyobjc-framework-Vision | Apple Vision bridge for face-aware framing (macOS) | MIT | [ronaldoussoren/pyobjc](https://github.com/ronaldoussoren/pyobjc) |
| opencv-contrib-python | Face detection (YuNet), people detection (HOG) and frame decoding on Windows and Linux | Apache-2.0; the wheels bundle FFmpeg (LGPL) and other libraries with their own notices | [opencv/opencv-python](https://github.com/opencv/opencv-python) |
| MediaPipe | Face landmarks (inner-lip opening) on Windows and Linux | Apache-2.0. Its dependencies: NumPy (BSD-3-Clause), matplotlib (matplotlib license, PSF-based), sounddevice (MIT), absl-py and FlatBuffers (Apache-2.0) | [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) |
| pywebview, optional desktop extra | Native application window | BSD-3-Clause | [r0x0r/pywebview](https://github.com/r0x0r/pywebview) |

FastAPI also brings Pydantic (MIT), Starlette (BSD-3-Clause) and AnyIO (MIT); their installed notices remain applicable. Apple Vision, Cocoa and WebKit are platform frameworks governed by Apple's platform terms; the PyObjC bridge license does not relicense those frameworks.

| Frontend package | Use | License | Upstream |
|---|---|---|---|
| React, React DOM | Desktop interface | MIT | [facebook/react](https://github.com/facebook/react) |
| lucide-react | Interface icons | ISC | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |

## Development, testing and packaging

| Tool or package | Use | License | Upstream |
|---|---|---|---|
| TypeScript | Static checking | Apache-2.0 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| Vite, @vitejs/plugin-react | UI development/build | MIT | [vitejs/vite](https://github.com/vitejs/vite), [vite-plugin-react](https://github.com/vitejs/vite-plugin-react) |
| Rollup | Bundle generation | MIT | [rollup/rollup](https://github.com/rollup/rollup) |
| vite-plugin-singlefile | Bundle UI into one local HTML file | MIT | [richardtallent/vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) |
| Vitest | Frontend tests | MIT | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) |
| jsdom | Test DOM | MIT | [jsdom/jsdom](https://github.com/jsdom/jsdom) |
| @testing-library/dom, react, jest-dom, user-event | User-facing UI tests | MIT | [Testing Library](https://github.com/testing-library) |
| @types/react, @types/react-dom | Type declarations | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| pytest | Backend/launcher tests | MIT | [pytest-dev/pytest](https://github.com/pytest-dev/pytest) |
| Ruff | Python linting | MIT | [astral-sh/ruff](https://github.com/astral-sh/ruff) |
| setuptools, wheel | Python installation/build | MIT | [pypa/setuptools](https://github.com/pypa/setuptools), [pypa/wheel](https://github.com/pypa/wheel) |
| PyInstaller | Optional Mac bundle build | GPL-2.0-or-later with PyInstaller's bootloader/distribution exception | [PyInstaller license](https://pyinstaller.org/en/stable/license.html) |
| Python / SQLite | Runtime and local state | Python: PSF license and included third-party notices; SQLite: public domain | [Python licensing](https://docs.python.org/3/license.html), [SQLite copyright](https://www.sqlite.org/copyright.html) |
| Node.js / npm | Build and package tools | Node.js: MIT plus included third-party notices; npm CLI: Artistic-2.0 | [Node.js](https://github.com/nodejs/node/blob/main/LICENSE), [npm CLI](https://github.com/npm/cli/blob/latest/LICENSE) |

Git/GitHub and GitHub Actions provide version control, reviews and CI. Individual Actions retain their upstream notices; GitHub's hosted service terms apply. The landing page has no runtime npm dependency and uses browser APIs, CSS and JavaScript.

## Optional local inference and model assets

Runtime setup is explicit and installs a separate environment. Model weights are downloaded separately after license consent; they are not bundled in the source repository or normal Mac app build. See [`clip_factory/models.py`](../clip_factory/models.py) for the actual catalog and runtime pins.

| Component | Role | License / source |
|---|---|---|
| MLX, mlx-metal | Apple Silicon inference | MIT; [MLX license](https://github.com/ml-explore/mlx/blob/main/LICENSE) |
| mlx-vlm 0.7.12 | Local vision-language inference | MIT; [mlx-vlm license](https://github.com/Neywa-Labs/mlx-vlm/blob/main/LICENSE) |
| mlx-whisper 0.4.3 | Local speech transcription | MIT; [MLX examples license](https://github.com/ml-explore/mlx-examples/blob/main/LICENSE) |
| faster-whisper 1.2.1 | Local speech transcription on Windows and Linux x64 | MIT; [faster-whisper license](https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE). Its bundled Silero VAD model is MIT. |
| CTranslate2 4.9.0 | Whisper inference engine for faster-whisper | MIT; [CTranslate2 license](https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE) |
| PyAV 18.0.0, ONNX Runtime, tokenizers | faster-whisper dependencies (audio decoding, voice detection, tokenizer) | PyAV BSD-3-Clause, its wheels bundle FFmpeg under LGPL; ONNX Runtime MIT; tokenizers Apache-2.0. [PyAV](https://github.com/PyAV-Org/PyAV), [ONNX Runtime](https://github.com/microsoft/onnxruntime), [tokenizers](https://github.com/huggingface/tokenizers) |
| NVIDIA cuBLAS 12 and cuDNN 9 wheels | GPU transcription, installed only on computers with an NVIDIA GPU | NVIDIA proprietary licenses shipped in the [nvidia-cublas-cu12](https://pypi.org/project/nvidia-cublas-cu12/) and [nvidia-cudnn-cu12](https://pypi.org/project/nvidia-cudnn-cu12/) wheels; downloaded from PyPI on that computer, never redistributed by the app. |
| python-build-standalone 3.12.16 (20261110) | App-owned Python for the local runtime when no native Python 3.12 is found | Python PSF license plus the bundled notices in each archive; [python-build-standalone](https://github.com/astral-sh/python-build-standalone) |
| Ollama | Optional local model server | MIT; [Ollama license](https://github.com/ollama/ollama/blob/main/LICENSE). Model licenses are separate. |
| Kokoro 0.9.4 | Optional standalone narration, not automatic voice-over mixing | Apache-2.0; [Kokoro license](https://github.com/hexgrad/kokoro/blob/main/LICENSE) |
| SoundFile | Narration audio files | BSD-3-Clause for Python SoundFile; its libsndfile dependency has separate LGPL-2.1-or-later terms; [SoundFile](https://github.com/bastibe/python-soundfile), [libsndfile](https://github.com/libsndfile/libsndfile) |
| spaCy and en_core_web_sm 3.8.0 | Kokoro text processing | MIT; [spaCy](https://github.com/explosion/spaCy), [model release](https://github.com/explosion/spacy-models/releases/tag/en_core_web_sm-3.8.0) |
| Transformers / Safetensors | Local model loading and tensor files | Apache-2.0; [Transformers](https://github.com/huggingface/transformers), [Safetensors](https://github.com/safetensors/safetensors) |
| NumPy, PyTorch, Pillow | Supporting numerical, model and image runtime | Preserve the installed distributions' complete bundled notices. NumPy and PyTorch include multiple third-party licenses; Pillow reports MIT-CMU. [NumPy](https://github.com/numpy/numpy), [PyTorch](https://github.com/pytorch/pytorch), [Pillow](https://github.com/python-pillow/Pillow) |
| Qwen3-VL-4B-Instruct | Local vision model used in development | Apache-2.0 per [upstream model card](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct); conversions/quantizations require their own upstream notices too. |
| Catalog Qwen3.5 9B / 35B-A3B MLX conversions | Optional larger local models | Catalog identifies Apache-2.0; inspect the exact [9B](https://huggingface.co/mlx-community/Qwen3.5-9B-MLX-4bit) or [35B](https://huggingface.co/mlx-community/Qwen3.5-35B-A3B-4bit) repository and upstream terms before use. Catalog labels are not a license grant. |
| Whisper large-v3-turbo MLX conversion | Speech-model weights | OpenAI upstream MIT; [Whisper license](https://github.com/openai/whisper/blob/main/LICENSE), [MLX conversion](https://huggingface.co/mlx-community/whisper-large-v3-turbo). Retain conversion metadata and upstream notices. |
| Whisper large-v3-turbo CTranslate2 conversion | Speech-model weights on Windows and Linux x64 | OpenAI upstream MIT; [Whisper license](https://github.com/openai/whisper/blob/main/LICENSE), [CTranslate2 conversion](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo) (MIT). Retain conversion metadata and upstream notices. |
| YuNet face detector (`face_detection_yunet_2023mar.onnx`, 0.23 MB) | Bundled in `clip_factory/face_models` for face detection on Windows and Linux | MIT per [opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) |
| MediaPipe Face Landmarker (`face_landmarker.task`, float16 v1, 3.8 MB) | Bundled in `clip_factory/face_models` for mouth movement on Windows and Linux | Apache-2.0 per the [model card](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) |
| Kokoro-82M weights and selected voices | Optional narration assets | Apache-2.0 per [model card](https://huggingface.co/hexgrad/Kokoro-82M); preserve its acknowledgments and asset-specific notices. |

`narrowed` in `team.py` is a project function for schema constraints, not a third-party package. Installed runtime dependencies such as tokenizer, audio and language packages have additional licenses; their metadata/license files must accompany any redistribution of that runtime.

## External media tools

FFmpeg and FFprobe are separately installed executables invoked by the app. Their license depends on the exact build: FFmpeg's base is LGPL-2.1-or-later, while enabled GPL components change the applicable license. See [FFmpeg's own licensing guidance](https://ffmpeg.org/legal.html).

The separately installed development binary reviewed for this submission reports FFmpeg 4.4 with `--enable-gpl`, `--enable-version3` and `--enable-nonfree`. It must not be described as an MIT asset or a freely redistributable bundled binary. This repository's app-build path does not bundle it. A future distribution must use a suitable independently audited build and preserve the notices/source obligations of its codecs and libraries, including libass, FreeType, x264 and any other enabled components.

## Fonts, icons, logos and demonstration media

- The Pearl desktop interface uses the native system font stack; it does not redistribute Apple's system font files.
- The landing page loads **Bricolage Grotesque** and **Inter** from Google Fonts under SIL Open Font License 1.1: [Bricolage Grotesque OFL](https://github.com/google/fonts/blob/main/ofl/bricolagegrotesque/OFL.txt), [Inter OFL](https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt).
- Lucide icons retain the ISC license noted above.
- The desktop PNG logo is founder-supplied artwork; its provenance is documented in [`logo-source.md`](logo-source.md). The source image is not an open-source font or icon dependency.
- Landing-page project-native SVG marks and generated alpine sample imagery are described in [`landing-page/ASSETS.md`](../landing-page/ASSETS.md). Generated illustrations are demonstration assets, not customer outputs or endorsements. Generative-service terms apply to their creation.
- All-In and other third-party video used for internal testing remain their owners' media. This project license does not grant rights to republish source episodes, names, likenesses, music or brands. Public demo footage must be owned, licensed or otherwise cleared for that use; do not treat test-media availability as clearance.
- Face-detection test fixtures (`tests/fixtures/faces`) are NASA photographs in the public domain (Apollo 11 crew, 1969; Sally Ride, 1984, via Wikimedia Commons), resized for tests.
- FFmpeg resolves the configured caption font on the host machine. No third-party font file is licensed by selecting its family name in the app; user-imported brand fonts and logos retain their own rights and notices.

## APIs, sponsor tools and AI assistance

Hosted APIs are not relicensed under this project's license. Access, billing, output and data processing follow each provider's applicable terms.

| Service/tool | Actual use | Terms / disclosure |
|---|---|---|
| Composio | Explicit Instagram account/tool integration, provider reads and human-approved publication path | [Composio](https://composio.dev/); account permissions and provider terms apply. Sponsor tool used. |
| Supabase | Optional account authentication and temporary approved-media/cover hosting | [Supabase](https://supabase.com/); hosted-service terms apply. The app does not redistribute the hosted service. |
| OpenRouter | Optional cloud-role routing and factory-builder model calls | [OpenRouter](https://openrouter.ai/); router and chosen model-provider terms/pricing apply. Cloud requests can transmit selected text and opted-in frames. |
| Anthropic Claude | Configured cloud models via OpenRouter; builder/code assistance | [Anthropic](https://www.anthropic.com/). Proprietary model/service terms apply; no model weights bundled. Claude-assisted commits are identified in repository history. |
| OpenAI Codex / ChatGPT tooling | Development, code review, documentation and visual assistance | [OpenAI](https://openai.com/). Development service, not a bundled application dependency. |
| 8090 Software Factory | Requirements/work-order/blueprint and implementation-review records | [8090](https://8090.ai/); service terms apply. Context is recorded in [`design-handoff.md`](design-handoff.md) and `.sw-factory/`. |
| Vercel | Landing-page and isolated sample-interface hosting | [Vercel](https://vercel.com/); hosting terms apply. Hosted sample UI is not a running Mac engine. Sponsor tool used. |
| GitHub | Repository, Actions, review and optional builder draft-PR handoff | [GitHub](https://github.com/); hosted-service terms apply. |
| Instagram / Meta | Connected-account publication and observed media insights | [Meta for Developers](https://developers.facebook.com/); applicable account, platform and API terms apply. |

No ElevenLabs or HydraDB integration is evidenced in the submitted application baseline. Do not select a sponsor merely because it is offered on the submission form. Offline narration currently uses Kokoro, which is distinct from ElevenLabs.

## Reproducible attribution checks

Read `pyproject.toml`, `frontend/package.json` and `frontend/package-lock.json` for declared and resolved dependencies. For a release, enumerate installed Python `importlib.metadata` distributions (including the separate inference runtime), collect their `License-Expression`, license classifiers, copyright and bundled license files, and inventory the actual app archive. Check `ffmpeg -version` and the exact binary's license before distributing media tools. Model repository revisions and imported media/brand assets require separate review.

The project has not claimed that this direct inventory certifies every transitive asset, downloaded model or future packaged build.
