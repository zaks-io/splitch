import { defineConfig } from "vitest/config";
import { D1_TEST_FILES } from "./vitest.d1-tests";

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
        find: "@splitch/db/test-d1-pool",
        replacement: new URL("../../packages/db/src/repo/test-d1-pool.ts", import.meta.url)
          .pathname,
      },
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
    name: "unit",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["test/**/*.{test,spec}.ts", ...D1_TEST_FILES],
    // The verify graph runs many vitest processes at once; the 5s default
    // flakes under that CPU contention (SPL-231).
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
