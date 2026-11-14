"""Supabase Storage hosting with mocked HTTP; no bucket or object is ever created."""

from types import SimpleNamespace

import httpx
import pytest

from clip_factory.cloud import AuthSession, CloudConfig, CloudError
from clip_factory.publish_storage import MAX_BYTES, PublishStorage, PublishStorageError

USER = "0f6c3b0e-6a5e-4a4e-9a55-2b6a7c1d9e10"
SHA = "a" * 64
URL = "https://proj.supabase.co"


class FakeClient:
    def __init__(self, user=USER, refresh_ok=True):
        self.config = CloudConfig(URL, "sb_publishable_x")
        self.session, self.user, self.refresh_ok, self.refreshes = None, user, refresh_ok, 0

    def refresh(self):
        self.refreshes += 1
        if not self.refresh_ok:
            raise CloudError("Your cloud session expired. Sign in again.", 401)
        self.session = AuthSession(self.user, "e@x.io", f"access-{self.refreshes}")
        return self.session


def account(signed_in=True, **client):
    fake = FakeClient(**client)
    return SimpleNamespace(client=fake, link=lambda: {"user_id": USER} if signed_in else None,
                           status=lambda: {"signed_in": signed_in})


def storage(handler, acct=None):
    return PublishStorage(acct or account(), transport=httpx.MockTransport(handler))


def head_ok(request, size):
    return httpx.Response(200, headers={"content-type": "video/mp4", "content-length": str(size)})


def test_upload_uses_user_session_and_verifies_public_url(tmp_path):
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"x" * 100)
    seen = []

    def handler(request):
        seen.append(request)
        if request.method == "POST":
            assert request.url.path == f"/storage/v1/object/gf-publish/{USER}/{SHA}.mp4"
            assert request.headers["authorization"] == "Bearer access-1"
            assert request.headers["apikey"] == "sb_publishable_x"
            assert request.headers["content-type"] == "video/mp4"
            assert request.headers["x-upsert"] == "false"
            assert request.read() == b"x" * 100
            return httpx.Response(200, json={"Key": "gf-publish/x"})
        assert request.method == "HEAD" and "authorization" not in request.headers
        assert request.url.path == f"/storage/v1/object/public/gf-publish/{USER}/{SHA}.mp4"
        return head_ok(request, 100)

    result = storage(handler).upload(clip, SHA)
    assert result == {"url": f"{URL}/storage/v1/object/public/gf-publish/{USER}/{SHA}.mp4",
                      "object": f"{USER}/{SHA}.mp4", "bytes": 100, "reused": False}
    assert [r.method for r in seen] == ["POST", "HEAD"]


def test_existing_object_is_reused_after_exact_head(tmp_path):
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"x" * 10)

    def handler(request):
        if request.method == "POST":
            return httpx.Response(400, json={"statusCode": "409", "error": "Duplicate",
                                             "message": "The resource already exists"})
        return head_ok(request, 10)

    assert storage(handler).upload(clip, SHA)["reused"] is True


def test_oversize_is_refused_before_any_request(tmp_path):
    clip = tmp_path / "big.mp4"
    with clip.open("wb") as f:
        f.truncate(MAX_BYTES + 1)
    with pytest.raises(PublishStorageError) as error:
        storage(lambda r: pytest.fail("no request")).upload(clip, SHA)
    assert error.value.code == "too_large" and "50 MB" in error.value.message


def test_not_public_and_missing_bucket_and_expired_session(tmp_path):
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"x" * 10)

    def private(request):
        if request.method == "POST":
            return httpx.Response(200, json={})
        return httpx.Response(400, json={"error": "not found"})

    with pytest.raises(PublishStorageError) as error:
        storage(private).upload(clip, SHA)
    assert error.value.code == "not_public"

    def missing(request):
        return httpx.Response(404, json={"error": "Bucket not found"})

    with pytest.raises(PublishStorageError) as error:
        storage(missing).upload(clip, SHA)
    assert error.value.code == "bucket_missing"

    with pytest.raises(PublishStorageError) as error:
        storage(lambda r: pytest.fail("no"), account(signed_in=False)).upload(clip, SHA)
    assert error.value.code == "sign_in_required"
    with pytest.raises(PublishStorageError) as error:
        storage(lambda r: pytest.fail("no"), account(refresh_ok=False)).upload(clip, SHA)
    assert error.value.code == "sign_in_required"
    with pytest.raises(PublishStorageError) as error:
        storage(lambda r: pytest.fail("no"), account(user="11111111-1111-1111-1111-111111111111")).upload(clip, SHA)
    assert error.value.code == "sign_in_required"


def test_expired_token_refreshes_once_and_resends_body(tmp_path):
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"y" * 7)
    bodies = []

    def handler(request):
        if request.method == "POST":
            bodies.append((request.headers["authorization"], request.read()))
            if len(bodies) == 1:
                return httpx.Response(400, json={"statusCode": "403", "error": "Unauthorized", "message": "jwt expired"})
            return httpx.Response(200, json={})
        return head_ok(request, 7)

    acct = account()
    storage(handler, acct).upload(clip, SHA)
    assert bodies == [("Bearer access-1", b"y" * 7), ("Bearer access-2", b"y" * 7)]


def test_delete_only_accepts_hash_object_names():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=[])

    s = storage(handler)
    assert s.delete("../other/file.mp4") is False and not calls
    assert s.delete(f"{USER}/{SHA}.mp4") is True
    assert calls[0].method == "DELETE" and calls[0].url.path == "/storage/v1/object/gf-publish"
