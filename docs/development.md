# Development, setup and Mac distribution

Current product overview: [README](../README.md). Current submission status: [submission checklist](submission/README.md). This document covers setup and operational boundaries; it is not a claim of a signed release or a verified live post.

## First run on macOS (Apple Silicon)

1. Download/clone this repository into a writable directory. Spaces in its path
   are supported. Do not run the app as root. Use a native arm64 terminal, not Rosetta.
2. Double-click **`Start Clip Factory.command`** in Finder. If executable permissions
   were lost while downloading, run `chmod +x "Start Clip Factory.command"` from
   this repository, or run `bash scripts/setup-mac.sh` in Terminal.
3. Setup locates native **Python 3.11/3.12**, creates `.venv`, builds the frontend
   if absent/outdated, and installs `.[desktop]`. It may require Command Line Tools
   (`xcode-select --install`) to build a dependency.
4. Missing Python can be installed with Homebrew **only after a confirmation**.
   If npm is missing, setup offers an opt-in Homebrew Node installation or explains
   how to install it. Node **22.12+** is recommended (Vite also supports 20.19+).
   Homebrew itself must be installed separately using its official instructions;
   these scripts never download and execute a remote shell installer.
5. Setup separately offers **`brew install ffmpeg-full`**. Declining does not invent
   media capabilities: rendering/transcription need real `ffmpeg` and `ffprobe`.
   Model downloads/runtime installation are **not** part of initial setup.

The launcher opens a real native window. Failure to create it is an error with
instructions; there is no invisible switch to browser mode. Closing the window
requests server shutdown and the parent app's worker cleanup. For dependency or
frontend updates, rerun `bash scripts/setup-mac.sh` explicitly.

### Explicit browser / headless modes

From the repository (or use absolute paths):

```sh
.venv/bin/clip-factory                         # native desktop
.venv/bin/clip-factory --browser               # deliberately use your browser
.venv/bin/clip-factory --headless              # server only; prints a local bootstrap URL
.venv/bin/clip-factory --browser --port 8765 --data-dir "$HOME/Clip Factory Data"
```

Default binding is **127.0.0.1, port 0** (an available ephemeral port, bound before
starting the server thread). `--host` accepts only loopback IPs or `localhost`;
LAN/wildcard binding is forbidden. `--browser` and `--headless` are mutually
exclusive. Browser/headless modes run until Ctrl-C or SIGTERM; closing a browser
tab is not a shutdown signal. The URL contains a new in-memory bootstrap secret;
opening it establishes the parent app's session cookie and redirects to a clean
URL. Do not share the URL. In headless mode it is intentionally printed to local
stdout; do not save stdout to persistent CI logs or files. The launcher disables
HTTP access logs and does not persist its token. A restart creates a new token.

For Linux development/CI, use Python supported by `pyproject.toml`,
`python -m pip install -e '.[test]' 'setuptools>=75' wheel`, and build the frontend
with `npm ci && npm run build` in `frontend/`. Use `python -m clip_factory.main --headless` or `--browser`.
This is **not** a supported Linux MLX/native desktop installation claim.

## Local storage, privacy, and model setup

- The parent application chooses its platform-specific data directory; its exact
  active location is returned by `/api/system` and displayed in the UI. Override
  it with `--data-dir`. This is separate from the repository/`.app`; replacing the
  application must not delete your media, models, or database.
- Back up the whole data directory **with the app stopped**. Files are local, not
  encrypted by this MVP; use FileVault/OS protections and protect backups. Deleting
  a database alone may leave media/model files. Uninstalling the bundle does not
  automatically erase user data or Keychain entries.
- Media and SQLite state are stored locally. Local inference is supported; enabling
  OpenRouter sends the relevant role inputs to the selected provider, and clip
  still frames require the corresponding opt-in. Website research contacts public
  sites. Composio publishing uploads approved video and cover to Supabase Storage
  for Instagram to fetch. **Local-first does not mean air-gapped**.
- No telemetry/remote assets are required by the bundled UI. Do not expose the
  local service with a tunnel or reverse proxy. Session authentication does not
  protect against other processes already running as you on your computer.
- Models are opt-in. Read each repository's actual license/use restrictions,
  confirm license acceptance, and check disk/memory requirements before download.
  The catalogue is not a license grant. Larger models compete with macOS, video
  processing, and other applications for unified memory; start with a small model.
- The parent's runtime setup installs inference dependencies in a **separate
  data-directory venv**, not into the packaged app. Clicking **Set up runtime**
  continues automatically if native Python 3.12 is missing: the app downloads a
  private Apple Silicon Python into its data directory, verifies its pinned
  SHA-256 and native architecture, then installs the inference dependencies.
  **No Homebrew, terminal command, administrator access, or app restart is needed
  for Python.** A working native Python already installed on the machine can be
  reused. Downloads require a network connection; partial/failed downloads are
  not activated. The private Python is reused on later setup attempts.
  The pinned distribution is CPython 3.12.16 from Astral's
  [20261110 python-build-standalone release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261110).
  The standalone `.app` does not bundle MLX, model weights, ffmpeg, or Homebrew;
  **FFmpeg remains a separate media-tool prerequisite.** This app-owned bootstrap
  applies to the packaged app; launching a source checkout still needs its setup
  prerequisites.
- Missing runtime/models/ffmpeg must show an unavailable state or a real failed
  job, never simulated model output. Manual editing does not require a language
  model; actual export still requires media tools. Model-weight downloads use a
  separate pool of **three parallel workers**, so downloads do not block runtime
  setup or production. Duplicate downloads of the same model are blocked, and
  conservative per-file disk reservations protect concurrent transfers. Each job
  has independent progress/cancellation. **One heavy job at a time** still limits
  inference, transcription, rendering, and runtime installation to protect memory
  and avoid modifying an in-use runtime. Shutdown cancels both lanes;
  failed/interrupted jobs need inspection before retry.

## Instagram, analytics, and paid controls

The current UI uses **Results → Accounts & tracking** and Studio's **Prepare your
post** sheet. See [Instagram connection](instagram-connect.md),
[publishing](instagram-publishing.md) and [learning loop](learning-loop.md).

- Composio account binding verifies the professional account and connection identity.
  A provider dashboard connection alone is not an app binding. Self-serve connection
  creation depends on the project's actual permission/capability configuration.
- An explicitly approved clip, account selection and publishing opt-in are required.
  Approved video and cover are hosted temporarily in Supabase Storage so Instagram
  can fetch them. A loopback media URL cannot be used as public hosting.
- Durable attempt states distinguish a confirmed post from an unknown provider
  outcome. Inspect/check status before considering another action; do not blind-retry.
- Schedules run while the app is open. Overdue posts need an explicit action. A
  closed laptop is not a hosted worker.
- Credentials use native Keychain. Local/cloud model calls, account authorization,
  publication and analytics are different operations with separate gates.
- The older direct-Meta adapter remains documented in [Meta setup](meta-setup.md);
  its configuration and Facebook-linked account requirements should not be presented
  as the complete current Composio connection flow.
- Missing observations stay unknown. Organic comparisons are observational. Paid
  ad activation, autonomous spending and causal ROAS optimization are not implemented.
- First real publication through the current app is a live acceptance gate, not
  established by unit tests or a rendered posting preview.

## Packaged Mac `.app`

The GitHub Actions workflow **Build Mac desktop artifact (not notarized)**
uses `macos-15` (arm64 in the current [official runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)),
asserts native OS/Python architecture, builds the frontend, copies it into
`clip_factory/ui`, runs backend/launcher tests, and uses PyInstaller to build a
windowed `Clip Factory.app`. `--add-data` includes the actual standalone
`inference_worker.py` for the external runtime. Before archiving, the build checks
that this file and **every built UI asset** match the bundle. It uploads a ZIP
**CI artifact**, not a published release. The installed UI package path is preferred by the parent server over
`frontend/dist`. No source-repository path should be required at runtime.

The workflow is registered on the default branch and supports explicit manual
dispatch. It also triggers for Mac-workflow-file changes on `8090/**` branches;
ordinary source pushes do not publish a release. Select the reviewed branch/ref
explicitly and confirm the run's head SHA before trusting its artifact.

```sh
gh workflow run mac-app.yml --repo MaxtheN/theclipfactory --ref master
```

Dispatching a build, uploading a release and validating a clean Mac installation
are separate actions. This documentation refresh did not perform them.

Local build on an Apple Silicon Mac with Python 3.12, Node and dependencies:

```sh
python3.12 -m venv .venv
source .venv/bin/activate
bash scripts/build-mac-app.sh
```

Output: `dist/Clip Factory.app` and `dist/clip-factory-mac-arm64.zip`.
There is no Developer ID certificate/notarization in this build. PyInstaller uses
**ad-hoc signing** on arm64; it does not establish a trusted publisher. Download
only an artifact whose source and provenance you trust. Extract it, move it to
Applications, and use Finder **right-click → Open**; macOS may require a per-app
confirmation under System Settings → Privacy & Security. If your macOS policy
blocks unnotarized apps entirely, use the reviewed source setup or a properly
signed build instead. **Do not disable Gatekeeper globally**, and do not blindly
remove quarantine from unknown downloads.

The launcher preserves existing PATH and adds `/opt/homebrew/bin`,
`/usr/local/bin`, `/usr/bin`, and `/bin` so a Finder launch can locate installed
ffmpeg/Python tools. Install required tools separately. The packaged headless
smoke is not proof that a real native window, Keychain prompt, or M5 inference
works; perform the [manual Mac checklist](mac-testing.md).

## Development and verification

```sh
python -m pip install -e '.[test]' 'setuptools>=75' wheel
python -m pytest tests scripts/tests -q
python -m ruff check clip_factory scripts
(cd frontend && npm ci && npm test && npm run build)
python scripts/smoke-headless.py
```

CI runs frontend build/tests and backend/launcher tests on Linux and macOS. The
headless smoke uses temporary data, authenticates through the real bootstrap
redirect/cookie, loads the UI, and requests graceful shutdown; it keeps the token
out of its output. Launcher unit tests use a minimal parent-app seam and a real
local socket. They do not assert real model inference or Meta permissions.

### Troubleshooting and known limits

- **App bounces then closes / native window fails:** launch errors are recorded
  without session tokens in `logs/startup.log` inside the app data directory
  (normally `~/Library/Application Support/ClipFactory` on macOS). Packaged native
  launches show an error dialog when Cocoa is available. Startup readiness uses
  a lightweight authenticated health endpoint, not MLX imports; runtime status
  probes are serialized and briefly cached. Do not delete downloaded models or
  your database to troubleshoot. The Mac workflow now opens/closes the real Cocoa
  window and reopens it with a deliberately slow runtime-status test double;
  target-machine inference still needs separate validation.
- **Port unavailable:** omit `--port` for ephemeral binding or select another
  loopback port. Startup readiness is bounded to 30 seconds.
- **UI missing/stale:** rerun setup/build; packaged UI must be built before
  freezing. The launcher itself does not run a dev server or fetch remote UI.
- **ffmpeg unavailable from Finder:** install native Homebrew ffmpeg-full (caption-capable build); check both
  `ffmpeg` and `ffprobe` in `/api/system`. No Linux package command is run on Mac.
- **Runtime/model job fails:** retry **Set up runtime** after checking network,
  disk space, license and the actual job error. The app handles missing native
  Python itself; it does not install Homebrew or change system Python. MLX still
  requires native Apple Silicon macOS; no claim that MLX works on Linux.
- **Meta action fails:** inspect account eligibility/scopes/expiry/public URL;
  never blindly retry a publish with an unknown upstream write outcome.
- Hardware/native acceptance, real model quality/performance, approved Meta app
  flows, live publishing/insights, and notarized distribution require separate
  validation. Automated tests are not a declaration of production readiness.
