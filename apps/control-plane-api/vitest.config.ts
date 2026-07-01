import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@splitch/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url)
        .pathname,
      "@splitch/db": new URL("../../packages/db/src/index.ts", import.meta.url).pathname,
      "@splitch/worker-runtime": new URL(
        "../../packages/worker-runtime/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});
