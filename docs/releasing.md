# Releasing signed desktop builds

How the desktop apps are signed in CI, the secrets that turn signing on, and how to cut a release.
Builds without the secrets still succeed: they are unsigned (ad-hoc on the Mac), and the job summary
says so.

| Build | Workflow | With the secrets | Without them |
|---|---|---|---|
| Mac (Apple Silicon) `growth-factory-mac-arm64.zip` | `mac-app.yml` | Developer ID signed with the hardened runtime, notarized and stapled | Ad-hoc signed; Gatekeeper blocks a downloaded copy |
| Windows `growth-factory-windows-x64-setup.exe` | `desktop-apps.yml` | The app's two executables and the installer Authenticode-signed and timestamped | Unsigned; SmartScreen warns |
| Linux `growth-factory-linux-x86_64.AppImage` | `desktop-apps.yml` | Not signed (out of scope) | Not signed |

Each build writes a `*.manifest.json` with a `signing` field:
- Mac: `developer_id_notarized`, `developer_id` or `ad_hoc_verified`;
- Windows: `authenticode_certificate`, `authenticode_trusted_signing` or `unsigned`.

> **Not yet proven with real certificates.** The signing paths are tested with fake tools
> (`scripts/tests/test_release_signing.py`), and the unsigned paths run in CI. The first tag built with
> real secrets is the proof. If the hardened runtime breaks the app, the smoke tests in `mac-app.yml` fail
> on the signed build, before anything is attached to a release.

## How signing works

**Mac.** `mac-app.yml` imports the certificate into a temporary keychain and finds its
"Developer ID Application" identity. `scripts/build-mac-app.sh` then calls `scripts/sign-mac-app.sh`
before its smoke test. That script:
1. signs every Mach-O file, then each nested framework, then the app. It uses the hardened runtime, a
   secure timestamp and `packaging/macos/entitlements.plist`;
2. submits a zip to Apple with `notarytool --wait`. If Apple does not accept it, the script prints Apple's
   log and fails;
3. staples the ticket, then checks the result with `stapler validate` and `spctl --assess`.

The workflow then smoke-tests the signed app (headless, the managed Python bootstrap, and the real
Cocoa window) and deletes the keychain.

**Windows.** `desktop-apps.yml` sets up one of two signers, and `scripts/build-desktop-app.py` uses
`signtool` with SHA-256 and an RFC 3161 timestamp:
1. It signs `Growth Factory.exe` and `growth-factory-cli.exe` before Inno Setup packs them.
2. It signs the installer itself.
3. It checks each signature with `signtool verify /pa`.

CI then installs the signed installer silently and smoke-tests the installed app. The uninstaller that
Inno Setup generates is not signed.

**Release.** On a `v*` tag, both workflows attach their builds and manifests to one **draft** GitHub
release for that tag (`scripts/attach-release-assets.sh`). A shared concurrency group makes them take
turns. Nothing is ever published automatically, and a published release's files are never replaced.

## Secrets

Add them under **Settings → Secrets and variables → Actions**, or with `gh secret set NAME`
(for example `base64 -i certificate.p12 | gh secret set MACOS_CERTIFICATE_P12`). Each set is
optional; a missing set only turns its signing off. Secrets are not available to pull requests from
forks, so those builds are always unsigned.

### Mac: Developer ID signing

| Secret | What it is | How to get it |
|---|---|---|
| `MACOS_CERTIFICATE_P12` | Base64 of a `.p12` holding a **Developer ID Application** certificate and its private key | Join the Apple Developer Program. The Account Holder creates the certificate in Certificates, Identifiers & Profiles → Certificates → + → Developer ID Application, from a signing request made in Keychain Access. Install it, export it with its key from Keychain Access as `.p12`, then `base64 -i certificate.p12`. |
| `MACOS_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` | — |

### Mac: notarization

All three are needed. Without them, a Developer ID build is signed but not notarized, which
Gatekeeper still blocks when the app is downloaded.

| Secret | What it is | How to get it |
|---|---|---|
| `APPLE_API_KEY_P8` | The full text of an App Store Connect API key file (`AuthKey_….p8`) | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → +, with the Developer role. The file downloads only once. |
| `APPLE_API_KEY_ID` | The key's id (10 characters) | Shown next to the key |
| `APPLE_API_ISSUER_ID` | The team's issuer id (a UUID) | Shown above the key list |

### Windows: one of two signers

If both are set, the certificate is used.

**A. An exportable code-signing certificate.** Since June 2023, certificate authorities keep the
private keys of new code-signing certificates on hardware tokens or in cloud HSMs, and those keys
cannot be exported to a `.pfx`. Use this option only for a certificate you can export.

| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE_PFX` | Base64 of the `.pfx` with the private key (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` password |

CI imports the certificate into the runner's user certificate store, and `signtool` selects it by
thumbprint, so the password never appears on a command line.

**B. Azure Trusted Signing** (Microsoft's managed signing service). This is the practical choice for
CI.
1. In Azure, create a Trusted Signing account and pass its identity validation. Check Microsoft's
   current eligibility rules for organizations and individual developers.
2. Create a public-trust certificate profile.
3. Register an app in Microsoft Entra ID, give it a client secret, and grant it the
   **Trusted Signing Certificate Profile Signer** role on the account.

| Secret | What it is |
|---|---|
| `AZURE_TENANT_ID` | The Entra tenant (directory) id |
| `AZURE_CLIENT_ID` | The app registration's client id |
| `AZURE_CLIENT_SECRET` | Its client secret |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | The account's region endpoint, for example `https://eus.codesigning.azure.net/` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | The Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_PROFILE` | The certificate profile name |

CI installs Microsoft's `Microsoft.Trusted.Signing.Client` package from NuGet, and `signtool` signs
through its library. The Azure credentials are given only to the build step on Windows.

A newly signed app can still meet a SmartScreen warning until its certificate builds reputation.
Signing removes the "unknown publisher" warning.

## Cut a release

1. Set the version in both `clip_factory/__init__.py` (`__version__`) and `pyproject.toml`, and merge
   that to `master`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. Both workflows build, sign, smoke-test and
   attach to the draft release **v0.2.0**.
3. Read the **Signing** section of each job summary. Confirm the Mac manifest says
   `developer_id_notarized` and the Windows manifest says `authenticode_…`. Do not publish an unsigned
   build.
4. Download each file from the draft, install it on a clean Mac, Windows PC and Linux machine, and make
   one clip on each.
5. Publish: `gh release edit v0.2.0 --draft=false`. Mark older pre-releases as superseded.
6. Link the downloads on the website. `landing-page/site/pages/download.html` has no download links
   yet, and `landing-page/tests/pages.test.mjs` blocks installer links. Change that test to allow
   exactly the published release's assets.

## Check a download

- **Mac:** after unzipping, `spctl --assess --type execute --verbose=4 "Growth Factory.app"` should
  report `source=Notarized Developer ID`. `xcrun stapler validate "Growth Factory.app"` checks the
  stapled ticket.
- **Windows** (PowerShell): `Get-AuthenticodeSignature .\growth-factory-windows-x64-setup.exe` should
  report `Valid`, with the publisher's name.
- **Any system:** compare the file's SHA-256 with the `sha256` in its `.manifest.json`.

## Not covered

Auto-update, Linux package signing, a Mac App Store build and an Intel Mac build are not part of this.
The Mac bundle's version string is not set from `__version__` yet.
