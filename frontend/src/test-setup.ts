import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setPlatformOs } from "./platform";
// Tests read as the Mac unless they choose another OS; platform tests switch it themselves.
beforeEach(() => setPlatformOs("macos"));
afterEach(() => cleanup());
