import { useSyncExternalStore } from "react";

/**
 * The operating system the local service runs on, from `/api/system`'s `os`. Until that loads, a
 * guess from the browser stands in, so the first screen already reads right on Windows and Linux.
 */
export type Os = "macos" | "windows" | "linux";

export interface PlatformWords {
  os: Os;
  /** "Mac" / "computer", for phrases such as "the Mac itself". */
  device: string;
  /** "this Mac" / "this computer", mid-sentence. */
  computer: string;
  /** "This Mac" / "This computer", starting a sentence or as a label. */
  Computer: string;
  /** "your Mac" / "your computer". */
  yourComputer: string;
  /** The OS credential store, named as the engine's keystore names it. */
  keyStore: string;
  /** The same store in a short label, e.g. "Saved in Keychain". */
  keyStoreShort: string;
  /** The command-palette shortcut label: "⌘K" on macOS, "Ctrl+K" elsewhere. */
  paletteShortcut: string;
  /** The keys of that shortcut, one per <kbd>. */
  paletteKeys: readonly string[];
  /** How to install FFmpeg here, ending in the step after it. */
  installFfmpeg: string;
}

const WORDS: Record<Os, PlatformWords> = {
  macos: {
    os: "macos",
    device: "Mac",
    computer: "this Mac",
    Computer: "This Mac",
    yourComputer: "your Mac",
    keyStore: "macOS Keychain",
    keyStoreShort: "Keychain",
    paletteShortcut: "⌘K",
    paletteKeys: ["⌘", "K"],
    installFfmpeg: "Install it in Terminal with “brew install ffmpeg-full”, then refresh.",
  },
  windows: {
    os: "windows",
    device: "computer",
    computer: "this computer",
    Computer: "This computer",
    yourComputer: "your computer",
    keyStore: "Windows Credential Manager",
    keyStoreShort: "Credential Manager",
    paletteShortcut: "Ctrl+K",
    paletteKeys: ["Ctrl", "K"],
    installFfmpeg: "Install it in PowerShell with “winget install Gyan.FFmpeg”, then restart Growth Factory.",
  },
  linux: {
    os: "linux",
    device: "computer",
    computer: "this computer",
    Computer: "This computer",
    yourComputer: "your computer",
    keyStore: "your system keyring",
    keyStoreShort: "system keyring",
    paletteShortcut: "Ctrl+K",
    paletteKeys: ["Ctrl", "K"],
    installFfmpeg: "Install it with your package manager (for example “sudo apt install ffmpeg”), then refresh.",
  },
};

export function isOs(value: unknown): value is Os {
  return value === "macos" || value === "windows" || value === "linux";
}

/** The browser's best guess; anything unrecognised reads as a generic computer. */
export function guessOs(nav: Partial<Pick<Navigator, "platform" | "userAgent">> | undefined = globalThis.navigator): Os {
  const hint = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  if (/Mac/i.test(hint)) return "macos";
  if (/Win/i.test(hint)) return "windows";
  return "linux";
}

let current: Os = guessOs();
const listeners = new Set<() => void>();

/** Record the OS the local service reports. Ignores anything that is not a known OS. */
export function setPlatformOs(value: unknown) {
  if (!isOs(value) || value === current) return;
  current = value;
  listeners.forEach((listener) => listener());
}

export function currentOs(): Os {
  return current;
}

/** Wording for the current OS, for helpers outside React. */
export function platformWords(os: Os = current): PlatformWords {
  return WORDS[os];
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Wording for the current OS; re-renders when `/api/system` reports a different one. */
export function usePlatform(): PlatformWords {
  return WORDS[useSyncExternalStore(subscribe, currentOs, currentOs)];
}
