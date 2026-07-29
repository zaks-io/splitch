import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@splitch/control-plane-sdk/control-panel-identity",
        replacement: new URL(
          "../../packages/control-plane-sdk/src/control-panel-identity.ts",
          import.meta.url,
        ).pathname,
      },
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
      // Ordered before the bare "@splitch/db" entry: aliases match by prefix, so
      // the broader one would rewrite the subpath into `index.ts/test-d1`.
      {
        find: "@splitch/db/test-d1",
        replacement: new URL("../../packages/db/src/repo/test-d1.ts", import.meta.url).pathname,
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
