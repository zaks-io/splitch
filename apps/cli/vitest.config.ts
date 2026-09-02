import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@splitch/sdk/control-plane": fileURLToPath(
        new URL("../../packages/sdk/src/control-plane/index.ts", import.meta.url),
      ),
      "@splitch/observability/performance-spans": fileURLToPath(
        new URL("../../packages/observability/src/performance-spans.ts", import.meta.url),
      ),
      "@splitch/observability": fileURLToPath(
        new URL("../../packages/observability/src/index.ts", import.meta.url),
      ),
      "@splitch/sdk/local-evaluation": fileURLToPath(
        new URL("../../packages/sdk/src/local-evaluation/index.ts", import.meta.url),
      ),
      "@splitch/sdk": fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url)),
      "@splitch/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
      "@splitch/worker-runtime": fileURLToPath(
        new URL("../../packages/worker-runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
  },
});
