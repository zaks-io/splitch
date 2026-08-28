import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@splitch/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@splitch/privacy": fileURLToPath(
        new URL("../../packages/privacy/src/index.ts", import.meta.url),
      ),
      "@splitch/worker-runtime": fileURLToPath(
        new URL("../../packages/worker-runtime/src/index.ts", import.meta.url),
      ),
      "cloudflare:workers": fileURLToPath(
        new URL("./src/cloudflare-workers.test-fixture.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});
