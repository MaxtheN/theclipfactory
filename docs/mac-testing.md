# Mac acceptance checklist

Target: native Apple Silicon macOS, especially M5 Pro / 48 GB. Record macOS,
architecture, Python, ffmpeg, model versions/quantization, available memory/disk,
and commit SHA when testing. Do not record tokens or bootstrap URLs. All boxes
below are **manual acceptance work**, not claims of tests already passed.

## Source first run

- [ ] Clone/download to a writable path containing spaces; start from Finder and
  also an unrelated Terminal working directory.
- [ ] Native arm64 Python 3.11/3.12 is selected. Rosetta/Intel and Linux setup are
  rejected with actionable instructions.
- [ ] Missing Python asks before Homebrew installation. Missing Homebrew provides
  official-install guidance, not a curl-to-shell command. Decline each prompt:
  no dependency installation happens without consent.
- [ ] Missing npm provides an opt-in Node install; supported Node builds frontend.
  A current existing `frontend/dist/index.html` does not trigger unnecessary npm.
  Changing a frontend input then rerunning setup rebuilds the UI.
- [ ] `.venv` is isolated; an incompatible existing venv is rejected rather than
  silently overwritten. `.[desktop]` installs native Cocoa dependencies.
- [ ] Declining ffmpeg setup leaves a truthful unavailable state. Opting in makes
  ffmpeg/ffprobe discoverable, including from Finder.
- [ ] Double-click `Start Clip Factory.command` opens a real pywebview window,
  not a browser tab. UI renders without a Vite dev server or remote CDN assets.

## Launcher/session/lifecycle

- [ ] Default address is `127.0.0.1` with a bound ephemeral port. Wildcard/LAN
  `--host` values fail. Test explicit free `--port`, occupied port, and IPv6 `::1`
  where the OS supports it.
- [ ] Bootstrap URL redirects to `/`, removes its token, and sets the session
  cookie. Media playback/range requests authenticate using that same cookie.
  Requests without token/session are denied; hostile origins do not gain access.
- [ ] `/api/system` reports `desktop: true` in native mode, `false` in explicit
  browser/headless modes, and the actual platform/data/tool capabilities.
- [ ] Closing native window ends the server, frees port, and cleans up the serial
  worker/children. Repeat while a media/model job runs; no orphan ffmpeg/runtime
  process remains. Parent app lifespan is responsible for child pipeline cleanup.
- [ ] Ctrl-C/SIGTERM stops browser/headless modes. Closing browser tab alone does
  not stop the server. Force quit is not graceful; next start must recover state.
- [ ] Break the native GUI dependency: startup fails without opening a browser;
  `--browser` is an explicit alternative. Test server-start failure/readiness
  timeout with no hanging worker/server. Native errors do not expose tokens.
- [ ] `--data-dir` with spaces is respected. Restart uses fresh auth and preserves
  data. No tokens are written to logs/database/browser storage. Bootstrap stdout
  is only expected for `--headless`; use the smoke script for CI-safe output.

## Packaged artifact

- [ ] Dispatch `mac-app.yml`. Download the ZIP CI artifact; verify commit/build
  provenance. This is ad-hoc/unsigned trust level, **not notarized or a release**.
- [ ] Extract and move `.app` to Applications on a machine without the source
  checkout. Trust only reviewed artifacts. Test per-app right-click → Open and
  relevant macOS Privacy & Security approval; never disable Gatekeeper globally.
- [ ] Cocoa window opens and packaged `clip_factory/ui/index.html` serves. Test
  shell/Finder with minimal PATH; installed `/opt/homebrew/bin/ffmpeg` is found.
- [ ] Writable data is outside the app bundle; app replacement preserves data.
  Runtime setup uses external native Python and a separate venv, not the frozen
  executable as a Python interpreter. Missing external Python gives instructions.
- [ ] Keychain permits secure token storage/retrieval; locked/denied Keychain fails
  safely with no plaintext fallback. The artifact must include native backend.
- [ ] Launch packaged executable with `--headless` using
  `python scripts/smoke-headless.py --executable '.../Contents/MacOS/Clip Factory'`.
  This automated check tests bootstrap/cookie/cleanup, **not native windowing**.

## Media, inference, and external integrations

- [ ] Import a real video; preview, manually select a moment, render/export a
  vertical clip, and confirm output duration/audio/subtitles using actual media.
- [ ] Accept the actual model license and install a small model/runtime. Check
  disk use, memory pressure, inference and transcript quality; record observed
  timing rather than promising M5 throughput. Queue multiple heavy jobs: only
  one runs. Cancel during a job and inspect cleanup/recovery.
- [ ] Offline/missing tool/model/error paths give honest statuses, not fabricated
  analysis, metrics, or success. Back up stopped app data and verify restore.
- [ ] Follow [Meta setup](meta-setup.md) with an eligible test professional
  account/Page and approved/configured app. Verify real connection, token expiry,
  explicit approved publishing via public HTTPS asset, and real insights/nulls.
  Use only authorized test assets; do not treat mocks as live validation.
- [ ] Paid controls stay gated. No unattended campaign launch or spend exists.
  Manual events stay labeled manual; no causal/paid attribution is invented.

## Automated checks and limits

`ci.yml` runs frontend tests/build and backend/launcher tests on Linux/macOS;
`scripts/smoke-headless.py` tests the actual parent's boot redirect, UI, cookie,
and process termination using temporary data. `scripts/tests/test_launcher.py`
uses a minimal FastAPI seam with real sockets to test launcher behavior without
opening Cocoa. The Mac artifact workflow additionally freezes and smoke-tests
the executable. A passing headless job is **not** native GUI, live Meta, real model,
ffmpeg performance, M5 hardware, signing, or notarization acceptance.
