import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { currentOs, guessOs, platformWords, setPlatformOs, usePlatform } from "./platform";
import { useFactory } from "./useFactory";

afterEach(() => vi.unstubAllGlobals());

describe("platform", () => {
  it("guesses the OS from the browser until the local service reports one", () => {
    expect(guessOs({ platform: "MacIntel", userAgent: "" })).toBe("macos");
    expect(guessOs({ platform: "Win32", userAgent: "" })).toBe("windows");
    expect(guessOs({ platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("windows");
    expect(guessOs({ platform: "Linux x86_64", userAgent: "" })).toBe("linux");
    // Anything unrecognised reads as a generic computer, never as a Mac.
    expect(guessOs({ platform: "", userAgent: "" })).toBe("linux");
    expect(platformWords(guessOs(undefined)).computer).toBe("this computer");
  });

  it("names the computer, key store and shortcut for each OS", () => {
    expect(platformWords("macos")).toMatchObject({ computer: "this Mac", keyStore: "macOS Keychain", paletteShortcut: "⌘K" });
    expect(platformWords("windows")).toMatchObject({ computer: "this computer", keyStore: "Windows Credential Manager", paletteShortcut: "Ctrl+K" });
    expect(platformWords("linux")).toMatchObject({ computer: "this computer", keyStore: "your system keyring", paletteShortcut: "Ctrl+K" });
    expect(platformWords("macos").installFfmpeg).toContain("brew install ffmpeg-full");
    expect(platformWords("windows").installFfmpeg).toContain("winget install Gyan.FFmpeg");
    expect(platformWords("linux").installFfmpeg).toContain("sudo apt install ffmpeg");
    for (const os of ["windows", "linux"] as const)
      expect(JSON.stringify(platformWords(os))).not.toMatch(/Mac|Keychain|⌘|brew/);
  });

  it("ignores values that are not a known OS", () => {
    setPlatformOs("windows");
    setPlatformOs("Darwin arm64");
    setPlatformOs(undefined);
    expect(currentOs()).toBe("windows");
  });

  it("re-renders subscribers when the reported OS changes", () => {
    const { result } = renderHook(() => usePlatform());
    expect(result.current.computer).toBe("this Mac");
    act(() => setPlatformOs("linux"));
    expect(result.current.computer).toBe("this computer");
  });

  it("takes the OS from /api/system", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const list = ["/api/models", "/api/jobs", "/api/videos", "/api/clips"].includes(url);
      const body = url === "/api/system" ? { os: "windows", platform: "Windows AMD64" } : list ? [] : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderHook(() => useFactory());
    await waitFor(() => expect(currentOs()).toBe("windows"));
  });
});
