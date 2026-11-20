import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** `npm run perf`: the render benchmark only, kept out of the regular test run. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/perf/**/*.perf.test.tsx"],
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
