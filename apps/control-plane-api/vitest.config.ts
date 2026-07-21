import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@splitch/control-plane-sdk/panel-experiments",
        replacement: new URL(
          "../../packages/control-plane-sdk/src/panel-experiments.ts",
          import.meta.url,
        ).pathname,
      },
      {
        find: "@splitch/contracts",
        replacement: new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@splitch/control-plane-sdk",
        replacement: new URL("../../packages/control-plane-sdk/src/index.ts", import.meta.url)
          .pathname,
      },
      {
        find: "@splitch/db",
        replacement: new URL("../../packages/db/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@splitch/worker-runtime",
        replacement: new URL("../../packages/worker-runtime/src/index.ts", import.meta.url)
          .pathname,
      },
    ],
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["test/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});
