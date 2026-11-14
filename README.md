# Clip Factory — local-first Instagram MVP

An Apple Silicon desktop workspace for turning video into Instagram clips. The
native application uses **pywebview + FastAPI**, a built React/Vite UI, a local
SQLite-backed data directory, and a serial media/model worker. A Mac with an M5
Pro and 48 GB unified memory is a target machine, **not a guarantee that every
model fits or every pipeline has been hardware-validated**. See
[API_CONTRACT.md](API_CONTRACT.md) for the current integration contract and
[Mac testing](docs/mac-testing.md) for the release checklist.

## Team mode

Team production uses producer, footage analyst, creative strategist, editor,
critic, and performance analyst roles as fresh-context calls to **one shared
local model**. A durable local ledger records handoffs, evidence, validated
outputs, findings, revisions, timings, and clip lineage. Heavy inference/rendering
is serial—not a parallel swarm or six loaded models. Correction is bounded to
**at most two revision cycles**, with repeated edits stopping as no progress.
Baseline runs support comparison using observed results, not invented ROI.

Outputs require human review; a critic pass is not approval. Team roles have no
publish or ad-spend tools; existing external authorization gates remain separate.
No autonomous ads capability is promised. See the [team-mode contract](docs/team-mode.md).
Real MLX inference and native Mac behavior still require target-hardware testing.

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
5. Setup separately offers **`brew install ffmpeg`**. Declining does not invent
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
- Source media, clips, analysis, and model inference are intended to stay local.
  Installation uses package registries; model downloads contact their hosting
  service; explicitly connected Meta actions contact Meta. Publishing requires
  third-party public HTTPS media hosting. **Local-first does not mean air-gapped**.
- No telemetry/remote assets are required by the bundled UI. Do not expose the
  local service with a tunnel or reverse proxy. Session authentication does not
  protect against other processes already running as you on your computer.
- Models are opt-in. Read each repository's actual license/use restrictions,
  confirm license acceptance, and check disk/memory requirements before download.
  The catalogue is not a license grant. Larger models compete with macOS, video
  processing, and other applications for unified memory; start with a small model.
- The parent's runtime setup installs inference dependencies in a **separate
  data-directory venv**, not into the packaged app. This can require network
  access and a compatible native Python/toolchain. A PyInstaller bundle is not
  itself a usable system Python for building that runtime. A standalone `.app`
  does not bundle MLX, model weights, ffmpeg, or Homebrew.
- Missing runtime/models/ffmpeg must show an unavailable state or a real failed
  job, never simulated model output. Manual editing does not require a language
  model; actual export still requires media tools. A serial worker limits heavy
  jobs to one at a time. Failed/interrupted jobs need inspection before retry.

## Instagram, analytics, and paid controls

See [Meta setup](docs/meta-setup.md) for permissions, account eligibility,
Keychain storage, token expiry, API behavior, and actual integration limitations.

- This integration targets **Instagram API with Facebook Login**: an Instagram
  Business/Creator account linked to a Facebook Page, with the right Page access
  and Meta permissions. A personal account or a token alone does not guarantee
  publishing or insights. Meta app review/Advanced Access/business verification
  may be necessary outside app-role testing.
- Credentials belong in the native OS Keychain, not the browser/database. A
  locked/unavailable Keychain is an error, not permission to store plaintext.
- Publishing is off by default, requires an approved clip and explicit enabling,
  and requires a **public HTTPS video URL** Meta can fetch. The local media URL is
  not public hosting. OAuth requires correctly configured registered HTTPS
  redirect delivery; the random local desktop port is not promised to meet Meta's
  production callback requirements. Verify current Graph versions and scopes.
- Insights come from real Meta responses. Missing values are unknown/null, not
  zero. Manual events/creator ratings are labeled observations, not causal proof
  of follows, leads, or sales. Paid metrics are not automatically clip-attributed.
- **No autonomous ad campaign launch or spend automation is implemented.**
  Budget/ads settings are gates, not campaign execution. Paid insights require
  separately configured ad-account access and permissions. Do not interpret an
  objective, model suggestion, or budget value as permission to spend money.

## Packaged Mac `.app`

The manual GitHub Actions workflow **Build Mac desktop artifact (not notarized)**
uses `macos-15` (arm64 in the current [official runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)),
asserts native OS/Python architecture, builds the frontend, copies it into
`clip_factory/ui`, runs backend/launcher tests, and uses PyInstaller to build a
windowed `Clip Factory.app`. `--add-data` includes the actual standalone
`inference_worker.py` for the external runtime. Before archiving, the build checks
that this file and **every built UI asset** match the bundle. It uploads a ZIP
**CI artifact**, not a published release. The installed UI package path is preferred by the parent server over
`frontend/dist`. No source-repository path should be required at runtime.

Dispatch only after the final core/team verification commits are pushed. Select
the intended branch explicitly; no automatic merge or release occurs. GitHub
requires a dispatchable workflow on the default branch. If `mac-app.yml` exists
only on the working branch, it may not yet appear or be dispatchable—registration
is a parent/repository-owner task, not a reason to silently build `master`.

Once registered, the current task's branch can be selected explicitly:

```sh
gh workflow run mac-app.yml --repo MaxtheN/theclipfactory \
  --ref 8090/chat-instagram-local-mvp-8cfc3f
```

This is a **later manual action**, not part of Linux verification. Confirm the run's
head SHA matches the reviewed final commit before trusting its artifact.

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
works; perform the [manual Mac checklist](docs/mac-testing.md).

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

- **Native window fails:** rerun setup using native Python, inspect installed
  pywebview/Cocoa dependencies, or deliberately use `--browser`. A terminal launch
  can expose safe startup errors that a windowed bundle cannot display.
- **Port unavailable:** omit `--port` for ephemeral binding or select another
  loopback port. Startup readiness is bounded to 30 seconds.
- **UI missing/stale:** rerun setup/build; packaged UI must be built before
  freezing. The launcher itself does not run a dev server or fetch remote UI.
- **ffmpeg unavailable from Finder:** install native Homebrew ffmpeg; check both
  `ffmpeg` and `ffprobe` in `/api/system`. No Linux package command is run on Mac.
- **Runtime/model job fails:** verify a compatible external Python, license,
  network/disk/memory and the actual job error. No claim that MLX works on Linux.
- **Meta action fails:** inspect account eligibility/scopes/expiry/public URL;
  never blindly retry a publish with an unknown upstream write outcome.
- Hardware/native acceptance, real model quality/performance, approved Meta app
  flows, live publishing/insights, and notarized distribution require separate
  validation. Automated tests are not a declaration of production readiness.
