import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8765", changeOrigin: false } },
  },
  build: {
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    // The render benchmark runs on its own: `npm run perf`.
    exclude: [...configDefaults.exclude, "src/perf/**"],
    clearMocks: true,
    // Keep full-app jsdom suites within laptop and CI runner memory/CPU budgets.
    maxWorkers: 2,
  },
});
