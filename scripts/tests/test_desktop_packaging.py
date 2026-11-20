"""Windows and Linux packaging regression tests with fake archives and tools, not installer acceptance."""
import hashlib
import importlib.util
import io
import json
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), REPO / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fetch = load("fetch-ffmpeg")
assets = load("verify-bundle-assets")
build = load("build-desktop-app")

RELEASE = [
    "checksums.sha256",
    "ffmpeg-master-latest-win64-gpl.zip", "ffmpeg-master-latest-linux64-gpl.tar.xz",
    "ffmpeg-n8.1-latest-win64-gpl-8.1.zip", "ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz",
    "ffmpeg-n9.0-latest-win64-gpl-9.0.zip", "ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz",
    "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip", "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip",
    "ffmpeg-n10.0-latest-linuxarm64-gpl-10.0.tar.xz",
]


@pytest.mark.parametrize(("target", "expected"), [("windows", "ffmpeg-n9.0-latest-win64-gpl-9.0.zip"),
                                                  ("linux", "ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz")])
def test_newest_stable_static_gpl_build_is_chosen(target, expected):
    # Master snapshots, LGPL (no libx264), shared builds and other architectures are never bundled.
    assert fetch.choose_asset(RELEASE, target) == expected


def test_missing_build_is_an_error():
    with pytest.raises(RuntimeError, match="No stable GPL FFmpeg build for win64"):
        fetch.choose_asset(["ffmpeg-master-latest-win64-gpl.zip"], "windows")


def test_checksums_parse_sha256sum_lines():
    digest = "a" * 64
    assert fetch.parse_checksums(f"{digest}  one.zip\n{digest} *two.tar.xz\nnot a line\n") == {
        "one.zip": digest, "two.tar.xz": digest}


def archive_bytes(target, *, omit=None):
    top = "ffmpeg-n9.0-latest-x-gpl-9.0"
    suffix = ".exe" if target == "windows" else ""
    files = {f"{top}/bin/ffmpeg{suffix}": b"ffmpeg", f"{top}/bin/ffprobe{suffix}": b"ffprobe",
             f"{top}/bin/ffplay{suffix}": b"ffplay", f"{top}/LICENSE.txt": b"GPL", f"{top}/doc/x.html": b"doc"}
    files = {name: data for name, data in files.items() if not omit or not name.endswith(omit)}
    buffer = io.BytesIO()
    if target == "windows":
        with zipfile.ZipFile(buffer, "w") as zipped:
            for name, data in files.items():
                zipped.writestr(name, data)
    else:
        with tarfile.open(fileobj=buffer, mode="w:xz") as tarred:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tarred.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


@pytest.mark.parametrize(("target", "name"), [("windows", "ffmpeg-n9.0-latest-win64-gpl-9.0.zip"),
                                              ("linux", "ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz")])
def test_extract_keeps_only_tools_and_licence(tmp_path, target, name):
    archive = tmp_path / name
    archive.write_bytes(archive_bytes(target))
    out = tmp_path / "out"
    out.mkdir()
    fetch.extract(archive, out, target)
    suffix = ".exe" if target == "windows" else ""
    assert sorted(p.name for p in out.iterdir()) == sorted([f"ffmpeg{suffix}", f"ffprobe{suffix}", "FFMPEG-LICENSE.txt"])
    assert (out / "FFMPEG-LICENSE.txt").read_bytes() == b"GPL"


def test_extract_fails_without_ffprobe(tmp_path):
    archive = tmp_path / "ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz"
    archive.write_bytes(archive_bytes("linux", omit="bin/ffprobe"))
    with pytest.raises(RuntimeError, match="missing bin/ffprobe"):
        fetch.extract(archive, tmp_path, "linux")


def fake_release(monkeypatch, payload, published_digest):
    name = "ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz"
    responses = {
        fetch.RELEASE_API: json.dumps({"published_at": "2026-11-19T00:00:00Z", "assets": [
            {"name": n, "browser_download_url": f"https://example.test/{n}"} for n in RELEASE]}).encode(),
        "https://example.test/checksums.sha256": f"{published_digest}  {name}\n".encode(),
        f"https://example.test/{name}": payload,
    }
    monkeypatch.setattr(fetch, "get", lambda url: responses[url])
    checked = []
    monkeypatch.setattr(fetch, "check_capabilities", checked.append)
    monkeypatch.setattr(fetch, "host_target", lambda: "linux")
    return checked


def test_fetch_verifies_the_published_checksum_and_writes_a_source_notice(tmp_path, monkeypatch):
    payload = archive_bytes("linux")
    checked = fake_release(monkeypatch, payload, hashlib.sha256(payload).hexdigest())
    record = fetch.fetch("linux", tmp_path / "ffmpeg", tmp_path / "cache")
    assert record["asset"] == "ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz"
    notice = (tmp_path / "ffmpeg/FFMPEG-SOURCE.txt").read_text()
    assert record["sha256"] in notice and "GNU GPL" in notice and "ffmpeg.org/download" in notice
    assert checked == [tmp_path / "ffmpeg/ffmpeg"]


def test_fetch_refuses_an_archive_that_does_not_match(tmp_path, monkeypatch):
    fake_release(monkeypatch, archive_bytes("linux"), "0" * 64)
    with pytest.raises(RuntimeError, match="does not match its published SHA-256"):
        fetch.fetch("linux", tmp_path / "ffmpeg", tmp_path / "cache")
    assert not (tmp_path / "ffmpeg").exists()


def completed(stdout=""):
    return subprocess.CompletedProcess([], 0, stdout=stdout)


@pytest.mark.parametrize(("filters", "encoders", "error"), [
    (" ass  \n subtitles \n", " libx264 \n", None),
    (" subtitles \n", " libx264 \n", "lacks ass"),
    (" ass \n subtitles \n", " libopenh264 \n", "lacks libx264"),
])
def test_capability_check_needs_libass_and_libx264(monkeypatch, filters, encoders, error):
    monkeypatch.setattr(fetch.subprocess, "run", lambda command, **_: completed(
        filters if command[-1] == "-filters" else encoders))
    if error:
        with pytest.raises(RuntimeError, match=error):
            fetch.check_capabilities(Path("ffmpeg"))
    else:
        fetch.check_capabilities(Path("ffmpeg"))


def inputs(root):
    (root / "clip_factory/demo_ui").mkdir(parents=True)
    (root / "clip_factory/inference_worker.py").write_text("# worker\n")
    (root / "clip_factory/cloud_config.json").write_text("{}")
    for name in ("index.html", "app.js", "styles.css"):
        (root / "clip_factory/demo_ui" / name).write_text(name)
    (root / "clip_factory/fonts").mkdir()
    (root / "clip_factory/fonts/LiberationSans-Regular.ttf").write_bytes(b"font")
    (root / "clip_factory/face_models").mkdir()
    (root / "clip_factory/face_models/face_landmarker.task").write_bytes(b"model")
    (root / "frontend/dist").mkdir(parents=True)
    (root / "frontend/dist/index.html").write_text("<html></html>")


def onedir(root, bundle, *, faces=True, ffmpeg=True):
    """PyInstaller 6 onedir layout: data and bin/ under _internal."""
    package = bundle / "_internal/clip_factory"
    package.mkdir(parents=True)
    for name in ("inference_worker.py", "cloud_config.json"):
        shutil.copy(root / "clip_factory" / name, package)
    shutil.copytree(root / "frontend/dist", package / "ui")
    for tree in ("demo_ui", "fonts", *(["face_models"] if faces else [])):
        shutil.copytree(root / "clip_factory" / tree, package / tree)
    tools = bundle / "_internal/bin"
    tools.mkdir()
    for name in (("ffmpeg.exe", "ffprobe.exe") if ffmpeg else ()) + ("FFMPEG-LICENSE.txt", "FFMPEG-SOURCE.txt"):
        (tools / name).write_text(name)


@pytest.fixture
def fake_ffmpeg(monkeypatch):
    calls = []

    def run(command, **_):
        calls.append(command)
        return completed(" ass \n subtitles \n")

    monkeypatch.setattr(assets.subprocess, "run", run)
    return calls


def test_desktop_bundle_needs_face_models_and_runs_bundled_ffmpeg(tmp_path, fake_ffmpeg):
    inputs(tmp_path)
    onedir(tmp_path, tmp_path / "Growth Factory")
    assets.verify(tmp_path / "Growth Factory", tmp_path, desktop=True)
    assert [Path(c[0]).name for c in fake_ffmpeg] == ["ffmpeg.exe", "ffprobe.exe"]


def test_desktop_bundle_without_face_models_fails(tmp_path, fake_ffmpeg):
    inputs(tmp_path)
    onedir(tmp_path, tmp_path / "growth-factory", faces=False)
    assets.verify(tmp_path / "growth-factory", tmp_path)  # The Mac check does not need them.
    with pytest.raises(RuntimeError, match="missing or has stale"):
        assets.verify(tmp_path / "growth-factory", tmp_path, desktop=True)


def test_desktop_bundle_without_ffmpeg_fails(tmp_path, fake_ffmpeg):
    inputs(tmp_path)
    onedir(tmp_path, tmp_path / "growth-factory", ffmpeg=False)
    with pytest.raises(RuntimeError, match="missing FFmpeg"):
        assets.verify(tmp_path / "growth-factory", tmp_path, desktop=True)


def test_desktop_bundle_with_ffmpeg_lacking_libass_fails(tmp_path, monkeypatch):
    inputs(tmp_path)
    onedir(tmp_path, tmp_path / "growth-factory")
    monkeypatch.setattr(assets.subprocess, "run", lambda command, **_: completed(" scale \n"))
    with pytest.raises(RuntimeError, match="no libass"):
        assets.verify(tmp_path / "growth-factory", tmp_path, desktop=True)


@pytest.mark.parametrize("platform_name", ["darwin", "freebsd14"])
def test_build_refuses_other_systems(monkeypatch, platform_name):
    monkeypatch.setattr(build.sys, "platform", platform_name)
    with pytest.raises(SystemExit):
        build.host_target()


def test_build_refuses_arm(monkeypatch):
    monkeypatch.setattr(build.sys, "platform", "linux")
    monkeypatch.setattr(build.platform, "machine", lambda: "aarch64")
    with pytest.raises(SystemExit, match="Build on x64"):
        build.host_target()


@pytest.mark.parametrize("target", ["windows", "linux"])
def test_manifest_is_honest_about_signing_and_publishing(tmp_path, monkeypatch, target):
    artifact = tmp_path / build.TARGETS[target]["artifact"]
    artifact.write_bytes(b"installer")
    (tmp_path / "FFMPEG-SOURCE.txt").write_text(f"Build: ffmpeg-n9.0-latest-x-gpl-9.0.zip (SHA-256 {'b' * 64}) from x.\n")
    record = json.loads(build.write_manifest(target, artifact, tmp_path).read_text())
    assert record["sha256"] == hashlib.sha256(b"installer").hexdigest()
    assert record["signing"] == "unsigned" and record["release_published"] is False and record["download_url"] is None
    assert record["bundled_ffmpeg"] == {"asset": "ffmpeg-n9.0-latest-x-gpl-9.0.zip", "sha256": "b" * 64}
    assert record["version"] == build.app_version()
    assert ("SmartScreen" in record["limitations"][0]) == (target == "windows")


def test_spec_installer_and_appimage_agree_on_names():
    spec = (REPO / "packaging/growth-factory.spec").read_text()
    for tree in ("frontend/dist", "clip_factory/fonts", "clip_factory/face_models", "clip_factory/demo_ui",
                 "clip_factory/inference_worker.py", "clip_factory/cloud_config.json"):
        assert f'ROOT / "{tree}"' in spec
    assert '"bin"' in spec and 'name="growth-factory-cli"' in spec
    for target in ("windows", "linux"):
        assert f'"{build.TARGETS[target]["bundle"]}"' in spec
    iss = (REPO / "packaging/windows/growth-factory.iss").read_text()
    assert f"OutputBaseFilename={Path(build.TARGETS['windows']['artifact']).stem}" in iss
    assert "F3017226-FE2A-4295-8BDF-00C3A9A7E4C5" in iss  # The WebView2 Evergreen runtime's client id.
    assert "PrivilegesRequired=lowest" in iss and "MinVersion=10.0" in iss
    apprun = (REPO / "packaging/linux/AppRun").read_text()
    assert f'usr/lib/growth-factory/{build.TARGETS["linux"]["cli"]}" "$@"' in apprun
    assert 'PYWEBVIEW_GUI="${PYWEBVIEW_GUI:-qt}"' in apprun
    desktop = (REPO / "packaging/linux/growth-factory.desktop").read_text()
    assert "Icon=growth-factory\n" in desktop and (REPO / "packaging/icons/growth-factory.png").is_file()


def test_workflow_builds_both_artifacts_on_dispatch_and_tags():
    workflow = (REPO / ".github/workflows/desktop-apps.yml").read_text()
    assert "workflow_dispatch:" in workflow and "tags:" in workflow
    assert "windows-latest" in workflow and "ubuntu-22.04" in workflow
    assert "scripts/build-desktop-app.py" in workflow and "scripts/smoke-headless.py" in workflow
    for target in ("windows", "linux"):
        assert build.TARGETS[target]["artifact"] in workflow
