import { afterEach, describe, expect, it, vi } from "vitest";
import { api, endpoint, post } from "./api";
afterEach(() => vi.unstubAllGlobals());
describe("same-origin API boundary", () => {
  it("uses session cookies and exact JSON field names", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"id":"job-1"}'));
    vi.stubGlobal("fetch", fetch);
    await post("/api/models/qwen-small/download", { accept_license: true });
    expect(fetch.mock.calls[0][0]).toBe("/api/models/qwen-small/download");
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      body: '{"accept_license":true}',
    });
    expect(fetch.mock.calls[0][1].headers.get("Content-Type")).toBe(
      "application/json",
    );
    expect(fetch.mock.calls[0][1].headers.has("X-Clip-Token")).toBe(false);
  });
  it("lets the browser generate multipart boundaries", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const body = new FormData();
    body.append("file", new File(["video"], "source.mp4"));
    await api("/api/videos", { method: "POST", body });
    expect(fetch.mock.calls[0][1].headers.has("Content-Type")).toBe(false);
  });
  it("shows actual backend error detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"detail":"License not accepted"}', { status: 409 }),
        ),
    );
    await expect(post("/api/models/qwen-small/download")).rejects.toThrow(
      "License not accepted",
    );
  });
  it("guards HTML error responses and explains authentication failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>private error</html>", { status: 401 }),
        ),
    );
    await expect(api("/api/system")).rejects.toThrow(
      "Open the app through its launcher",
    );
  });
  it("makes connection failures actionable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(api("/api/jobs")).rejects.toThrow(
      "Cannot reach the local service",
    );
  });
  it("rejects invalid success responses rather than fabricating success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(api("/api/clips")).rejects.toThrow("invalid JSON");
  });
  it("accepts empty deletes and refuses cross-origin routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(
      api("/api/clips/c1", { method: "DELETE" }),
    ).resolves.toBeUndefined();
    await expect(api("https://example.com/api/clips")).rejects.toThrow(
      "same-origin",
    );
    expect(endpoint("videos", "a/b", "media")).toBe("/api/videos/a%2Fb/media");
  });
});
