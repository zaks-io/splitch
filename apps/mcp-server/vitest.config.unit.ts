import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@splitch/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@splitch/control-plane-sdk/mcp-operation-adapter": fileURLToPath(
        new URL("../../packages/control-plane-sdk/src/mcp-operation-adapter.ts", import.meta.url),
      ),
      "@splitch/control-plane-sdk/panel-experiments": fileURLToPath(
        new URL("../../packages/control-plane-sdk/src/panel-experiments.ts", import.meta.url),
      ),
      "@splitch/control-plane-sdk": fileURLToPath(
        new URL("../../packages/control-plane-sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "unit",
    include: ["src/**/*.{test,spec}.ts"],
    passWithNoTests: true,
    // The verify graph runs many vitest processes at once; the 5s default
    // flakes under that CPU contention (SPL-231).
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
