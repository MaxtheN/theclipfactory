import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFactory } from "./useFactory";
import { settings } from "./test-state";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function responses(path: string) {
  if (path === "/api/settings") return settings;
  if (
    path === "/api/system" ||
    path === "/api/instagram/status" ||
    path === "/api/analytics"
  )
    return {};
  return [];
}
describe("workspace state and polling", () => {
  it("exposes boot errors without injecting fixture data, then recovers on retry", async () => {
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        failing
          ? new Response('{"detail":"Service warming up"}', { status: 503 })
          : new Response(JSON.stringify(responses(path))),
      ),
    );
    const { result } = renderHook(useFactory);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errors.videos).toBe("Service warming up");
    expect(result.current.data.videos).toEqual([]);
    expect(result.current.data.system).toBeNull();
    failing = false;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.errors).toEqual({});
    expect(result.current.data.settings?.objective).toBe("discovery");
  });
  it("polls live data without repeatedly fetching editable settings", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async (path: string) => new Response(JSON.stringify(responses(path))),
    );
    vi.stubGlobal("fetch", fetch);
    const { result, unmount } = renderHook(useFactory);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(
      fetch.mock.calls.filter(([path]) => path === "/api/jobs"),
    ).toHaveLength(2);
    expect(
      fetch.mock.calls.filter(([path]) => path === "/api/settings"),
    ).toHaveLength(1);
    expect(
      fetch.mock.calls.some(([path]) => path.startsWith("/api/ads/")),
    ).toBe(false);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(
      fetch.mock.calls.filter(([path]) => path === "/api/jobs"),
    ).toHaveLength(2);
  });
  it("shows action failures and refreshes partially completed work", async () => {
    const fetch = vi.fn(
      async (path: string) => new Response(JSON.stringify(responses(path))),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(useFactory);
    await waitFor(() => expect(result.current.loading).toBe(false));
    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.run(async () => {
        throw new Error("Not enough disk space");
      }, "Should never appear");
    });
    expect(success).toBe(false);
    expect(result.current.actionError).toBe("Not enough disk space");
    expect(result.current.notice).toBe("");
    expect(result.current.busy).toBe(false);
    expect(
      fetch.mock.calls.filter(([path]) => path === "/api/videos"),
    ).toHaveLength(2);
  });
  it("rejects malformed list entries as data errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (path: string) =>
          new Response(
            JSON.stringify(path === "/api/models" ? [null] : responses(path)),
          ),
      ),
    );
    const { result } = renderHook(useFactory);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errors.models).toBe(
      "Invalid models response from local service.",
    );
  });
});
