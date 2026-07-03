import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@splitch/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@splitch/stats": fileURLToPath(
        new URL("../../packages/stats/src/index.ts", import.meta.url),
      ),
      "@splitch/worker-runtime": fileURLToPath(
        new URL("../../packages/worker-runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});
