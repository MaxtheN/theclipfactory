"""Release signing with fake signing tools: the order, inputs and honesty of each path, not Apple or
Microsoft acceptance. The first tag built with real certificates proves the signatures themselves."""
import importlib.util
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = [REPO / ".github/workflows/mac-app.yml", REPO / ".github/workflows/desktop-apps.yml"]
bash_only = pytest.mark.skipif(sys.platform == "win32", reason="runs bash scripts with fake tools")


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), REPO / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load("build-desktop-app")
manifests = load("write-release-manifest")
summary = load("signing-summary")


def executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/bash\nset -eu\n" + text)
    path.chmod(0o755)


# --- Mac: Developer ID signing and notarization ---

def fake_app(tmp_path):
    app = tmp_path / "dist/Growth Factory.app"
    for name in ("MacOS/Growth Factory", "Frameworks/libssl.dylib", "Frameworks/clip_factory/_native.so",
                 "Frameworks/Python.framework/Versions/3.12/Python", "Resources/clip_factory/ui/index.html"):
        (app / "Contents" / name).parent.mkdir(parents=True, exist_ok=True)
        (app / "Contents" / name).write_text(name)
    return app


def mac_tools(tmp_path, notary_status="Accepted"):
    tools, log = tmp_path / "tools", tmp_path / "calls.txt"
    executable(tools / "file", 'case "$2" in *.dylib|*.so|*/Python|*/MacOS/*) echo "Mach-O 64-bit";; *) echo text;; esac\n')
    executable(tools / "codesign", 'printf "codesign %s\\n" "$*" >> "$LOG"\n')
    executable(tools / "ditto", 'printf "ditto\\n" >> "$LOG"; touch "${@: -1}"\n')
    executable(tools / "spctl", 'printf "spctl %s\\n" "$*" >> "$LOG"\n')
    executable(tools / "xcrun", f'''printf "xcrun %s\\n" "$*" >> "$LOG"
if [[ "$1 $2" == "notarytool submit" ]]; then echo '{{"id": "sub-1", "status": "{notary_status}"}}'; fi
''')
    return tools, log


def sign(tmp_path, app, tools, log, **env):
    return subprocess.run(
        ["bash", str(REPO / "scripts/sign-mac-app.sh"), str(app)], capture_output=True, text=True, check=False,
        env={**os.environ, "PATH": f"{tools}:/usr/bin:/bin", "LOG": str(log),
             "GF_MAC_SIGN_IDENTITY": "Developer ID Application: Growth Factory (TEAM123456)", **env})


NOTARY = {"GF_NOTARY_KEY": "/tmp/key.p8", "GF_NOTARY_KEY_ID": "KEY123", "GF_NOTARY_ISSUER": "issuer-uuid"}


@bash_only
def test_mac_signing_is_inside_out_with_hardened_runtime_then_notarizes_staples_and_assesses(tmp_path):
    app = fake_app(tmp_path)
    tools, log = mac_tools(tmp_path)
    result = sign(tmp_path, app, tools, log, **NOTARY)
    assert result.returncode == 0, result.stderr
    calls = log.read_text().splitlines()
    signed = [re.sub(r".*/Contents/", "", call) for call in calls if call.startswith("codesign --force")]
    assert "Resources/clip_factory/ui/index.html" not in " ".join(signed), "only Mach-O files are signed"
    assert signed[-1].endswith("dist/Growth Factory.app")
    framework = next(i for i, call in enumerate(signed) if call.endswith("Frameworks/Python.framework"))
    assert framework > next(i for i, call in enumerate(signed) if call.endswith("Versions/3.12/Python"))
    assert len(signed) == 6  # four Mach-O files, one framework, the app
    for call in calls:
        if call.startswith("codesign --force"):
            assert "--options runtime" in call and "--timestamp" in call
            assert f"--entitlements {REPO}/packaging/macos/entitlements.plist" in call
            assert "--sign Developer ID Application: Growth Factory (TEAM123456)" in call
    order = [next(i for i, call in enumerate(calls) if call.startswith(prefix)) for prefix in (
        "codesign --verify", "ditto", "xcrun notarytool submit", "xcrun stapler staple", "xcrun stapler validate",
        "spctl --assess --type execute")]
    assert order == sorted(order)
    submit = next(call for call in calls if call.startswith("xcrun notarytool submit"))
    assert "--key /tmp/key.p8 --key-id KEY123 --issuer issuer-uuid --wait" in submit
    assert "notarized and stapled" in result.stdout


@bash_only
def test_rejected_notarization_fails_with_apples_log_and_never_staples(tmp_path):
    app = fake_app(tmp_path)
    tools, log = mac_tools(tmp_path, notary_status="Invalid")
    result = sign(tmp_path, app, tools, log, **NOTARY)
    calls = log.read_text()
    assert result.returncode != 0 and "not accepted" in result.stderr
    assert "xcrun notarytool log sub-1" in calls and "stapler" not in calls and "spctl" not in calls


@bash_only
def test_without_a_notary_key_the_app_is_signed_but_not_notarized(tmp_path):
    app = fake_app(tmp_path)
    tools, log = mac_tools(tmp_path)
    result = sign(tmp_path, app, tools, log)
    assert result.returncode == 0, result.stderr
    assert "xcrun" not in log.read_text() and "not notarized" in result.stdout


@bash_only
def test_signing_needs_an_identity(tmp_path):
    app = fake_app(tmp_path)
    tools, log = mac_tools(tmp_path)
    result = sign(tmp_path, app, tools, log, GF_MAC_SIGN_IDENTITY="")
    assert result.returncode != 0 and "GF_MAC_SIGN_IDENTITY" in result.stderr


def test_mac_build_signs_before_smoking_and_zipping():
    script = (REPO / "scripts/build-mac-app.sh").read_text()
    position = script.index('scripts/sign-mac-app.sh" ')
    assert position < script.index("smoke-headless.py") < script.index("/usr/bin/ditto")
    assert '--signing "$SIGNING"' in script
    plist = (REPO / "packaging/macos/entitlements.plist").read_text()
    assert "com.apple.security.cs.allow-unsigned-executable-memory" in plist
    assert "com.apple.security.app-sandbox" not in plist


@pytest.mark.parametrize(("signing", "recorded", "notarized"), [
    ("ad_hoc", "ad_hoc_verified", False), ("developer_id", "developer_id", False),
    ("developer_id_notarized", "developer_id_notarized", True)])
def test_mac_manifest_records_the_signing_it_got(tmp_path, signing, recorded, notarized):
    archive = tmp_path / "growth-factory-mac-arm64.zip"
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("Growth Factory.app/Contents/Info.plist", "fixture")
    record = manifests.manifest(archive, tmp_path, signing=signing, signature_verified=True)
    assert (record["signing"], record["notarized"]) == (recorded, notarized)
    assert record["release_published"] is False and record["download_url"] is None
    unverified = manifests.manifest(archive, tmp_path, signing=signing)
    assert unverified["signing"] == "unverified" and unverified["notarized"] is False
    with pytest.raises(ValueError):
        manifests.manifest(archive, tmp_path, signing="apple")


# --- Windows: Authenticode ---

def test_windows_builds_unsigned_without_a_signer():
    assert build.windows_signing({}) is None


def test_windows_certificate_signer_uses_a_thumbprint_sha256_and_a_timestamp():
    kind, arguments = build.windows_signing({"GF_WINDOWS_SIGN_THUMBPRINT": "ab" * 20})
    assert kind == "certificate"
    assert arguments == ["sign", "/sha1", "ab" * 20, "/fd", "sha256", "/tr", "http://timestamp.digicert.com",
                         "/td", "sha256"]
    assert not {"/p", "/f"} & set(arguments), "no certificate file or password on the command line"
    with pytest.raises(SystemExit, match="thumbprint"):
        build.windows_signing({"GF_WINDOWS_SIGN_THUMBPRINT": "not-a-thumbprint"})


def test_windows_trusted_signing_needs_its_library_and_metadata():
    kind, arguments = build.windows_signing({"GF_WINDOWS_SIGN_DLIB": "C:/ts/x64/Azure.CodeSigning.Dlib.dll",
                                             "GF_WINDOWS_SIGN_METADATA": "C:/ts.json"})
    assert kind == "trusted_signing"
    assert arguments[-4:] == ["/dlib", "C:/ts/x64/Azure.CodeSigning.Dlib.dll", "/dmdf", "C:/ts.json"]
    assert "http://timestamp.acs.microsoft.com" in arguments
    with pytest.raises(SystemExit, match="both"):
        build.windows_signing({"GF_WINDOWS_SIGN_DLIB": "C:/ts/x64/Azure.CodeSigning.Dlib.dll"})


def test_windows_signing_signs_then_verifies_each_file(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(build, "signtool", lambda: "signtool.exe")
    monkeypatch.setattr(build, "run", lambda *command, **_: calls.append([str(part) for part in command]))
    files = [tmp_path / "Growth Factory.exe", tmp_path / "setup.exe"]
    build.sign_windows(files, build.windows_signing({"GF_WINDOWS_SIGN_THUMBPRINT": "CD" * 20}))
    assert [call[1] for call in calls] == ["sign", "verify", "sign", "verify"]
    assert calls[1] == ["signtool.exe", "verify", "/pa", str(files[0])] and calls[2][-1] == str(files[1])


def test_windows_build_signs_the_app_before_packaging_and_the_installer_after():
    source = (REPO / "scripts/build-desktop-app.py").read_text()
    main = source[source.index("def main()"):]
    assert main.index("sign_windows([bundle") < main.index("package_windows(bundle)") < main.index(
        "sign_windows([artifact]")


def test_signed_windows_manifest_says_so(tmp_path):
    artifact = tmp_path / build.TARGETS["windows"]["artifact"]
    artifact.write_bytes(b"installer")
    (tmp_path / "FFMPEG-SOURCE.txt").write_text("no build line\n")
    record = json.loads(build.write_manifest("windows", artifact, tmp_path, "authenticode_certificate").read_text())
    assert record["signing"] == "authenticode_certificate"
    assert record["limitations"][0].startswith("Authenticode-signed")


# --- Job summary and draft release ---

@pytest.mark.parametrize(("record", "text", "notice"), [
    ({"artifact": "m.zip", "platform": "macOS", "signing": "developer_id_notarized"}, "notarized and stapled", False),
    ({"artifact": "m.zip", "platform": "macOS", "signing": "ad_hoc_verified"}, "ad-hoc", True),
    ({"artifact": "m.zip", "platform": "macOS", "signing": "developer_id"}, "not notarized", True),
    ({"artifact": "w.exe", "platform": "Windows", "signing": "unsigned"}, "WINDOWS_CERTIFICATE_", True),
    ({"artifact": "w.exe", "platform": "Windows", "signing": "authenticode_trusted_signing"}, "Trusted", False),
    ({"artifact": "l.AppImage", "platform": "Linux", "signing": "unsigned"}, "not signed", False)])
def test_summary_flags_every_build_not_signed_for_release(record, text, notice):
    line, annotation = summary.line(record)
    assert record["artifact"] in line and text in line
    assert (annotation is not None) == notice
    if annotation:
        assert annotation.startswith("::notice ")


def fake_gh(tmp_path, state):
    """A gh that remembers whether the release is missing, a draft or published."""
    (tmp_path / "release-state").write_text(state)
    executable(tmp_path / "tools/gh", f'''printf "gh %s\\n" "$*" >> "$LOG"
state="$(cat {tmp_path / "release-state"})"
case "$1 $2" in
  "release view")
    [[ "$state" == none ]] && exit 1
    if [[ "$*" == *isDraft* ]]; then [[ "$state" == published ]] && echo false || echo true; fi ;;
  "release create") echo draft > {tmp_path / "release-state"} ;;
esac
''')


@bash_only
@pytest.mark.parametrize("state", ["none", "draft", "published"])
def test_release_files_only_ever_go_to_a_draft(tmp_path, state):
    fake_gh(tmp_path, state)
    log = tmp_path / "gh.txt"
    log.touch()
    result = subprocess.run(["bash", str(REPO / "scripts/attach-release-assets.sh"), "v0.2.0", "a.zip", "b.json"],
                            capture_output=True, text=True, check=False,
                            env={**os.environ, "PATH": f"{tmp_path / 'tools'}:/usr/bin:/bin", "LOG": str(log)})
    calls = log.read_text()
    assert ("gh release create v0.2.0 --draft --verify-tag" in calls) == (state == "none")
    assert "--draft=false" not in calls and "release edit" not in calls
    if state == "published":
        assert result.returncode != 0 and "upload" not in calls
    else:
        assert result.returncode == 0, result.stderr
        assert "gh release upload v0.2.0 a.zip b.json --clobber" in calls


# --- Workflows and docs ---

def secret_names():
    return sorted({name for path in WORKFLOWS for name in re.findall(r"secrets\.([A-Z0-9_]+)", path.read_text())})


def test_secrets_reach_steps_only_through_env_never_inside_scripts():
    for path in WORKFLOWS:
        for line in path.read_text().splitlines():
            if "secrets." in line:
                assert re.match(r"^\s+[A-Z][A-Z0-9_]*: \$\{\{ .*secrets\.", line), f"{path.name}: {line.strip()}"


def test_every_signing_secret_is_documented_and_optional():
    names = secret_names()
    assert {"MACOS_CERTIFICATE_P12", "APPLE_API_KEY_P8", "WINDOWS_CERTIFICATE_PFX", "AZURE_CLIENT_SECRET"} <= set(names)
    releasing = (REPO / "docs/releasing.md").read_text()
    for name in names:
        assert f"`{name}`" in releasing, f"{name} is not documented in docs/releasing.md"
    for path in WORKFLOWS:
        text = path.read_text()
        # Signing steps run only when their secret is present, so forks and unconfigured repos still build.
        assert "!= ''" in text and "signing-summary.py" in text
        assert "draft-release-${{ github.ref_name }}" in text and "attach-release-assets.sh" in text
        assert "contents: write" in text.split("draft-release:")[1]
        assert "contents: write" not in text.split("draft-release:")[0]
