import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@splitch/control-plane-sdk/panel-experiments",
        replacement: fileURLToPath(
          new URL("../../packages/control-plane-sdk/src/panel-experiments.ts", import.meta.url),
        ),
      },
      {
        find: "@splitch/contracts",
        replacement: fileURLToPath(
          new URL("../../packages/contracts/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@splitch/control-plane-sdk",
        replacement: fileURLToPath(
          new URL("../../packages/control-plane-sdk/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@splitch/stats",
        replacement: fileURLToPath(new URL("../../packages/stats/src/index.ts", import.meta.url)),
      },
      {
        find: "@splitch/worker-runtime",
        replacement: fileURLToPath(
          new URL("../../packages/worker-runtime/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});
