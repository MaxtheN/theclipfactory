import { isPublicHttps } from "../urlSafety";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clip, testState } from "../test-state";
import { ClipReview } from "./ClipReview";
afterEach(() => vi.unstubAllGlobals());
const mockFetch = () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async (path: string) =>
        new Response(path === "/api/team/runs" ? "[]" : '{"id":"j1"}'),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
describe("public asset URL safety", () => {
  it.each([
    "http://example.com/a.mp4",
    "https://localhost/a.mp4",
    "https://127.0.0.1/a",
    "https://10.0.0.1/a",
    "https://192.168.1.1/a",
    "https://172.16.1.1/a",
    "https://[::1]/a",
    "https://user:secret@example.com/a",
    "not a url",
  ])("rejects local or unsafe asset %s", (url) =>
    expect(isPublicHttps(url)).toBe(false),
  );
  it("accepts public HTTPS assets", () =>
    expect(isPublicHttps("https://media.example.com/clip.mp4")).toBe(true));
});
describe("shared clip review contract", () => {
  it("approves the clip with current caption edits and offers same-origin downloads", async () => {
    const fetch = mockFetch();
    const user = userEvent.setup();
    render(<ClipReview state={testState()} clip={clip} />);
    await user.clear(screen.getByLabelText("Clip caption"));
    await user.type(screen.getByLabelText("Clip caption"), "New caption");
    await user.click(screen.getByRole("button", { name: "Approve clip" }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      hook: "Hook",
      caption: "New caption",
      approved: true,
    });
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/clips/c1/download",
    );
  });
});
