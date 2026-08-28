import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const sharedAlias = {
  "@splitch/contracts": fileURLToPath(
    new URL("../../packages/contracts/src/index.ts", import.meta.url),
  ),
  "@splitch/privacy": fileURLToPath(
    new URL("../../packages/privacy/src/index.ts", import.meta.url),
  ),
  "@splitch/sdk": fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url)),
  "@splitch/worker-runtime": fileURLToPath(
    new URL("../../packages/worker-runtime/src/index.ts", import.meta.url),
  ),
};

/**
 * Worker entrypoint imports are isolated so Durable Object suites still resolve
 * the real runtime instead of a plain-class stub.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        resolve: {
          alias: {
            ...sharedAlias,
            "cloudflare:workers": fileURLToPath(
              new URL("./test-stubs/cloudflare-workers.ts", import.meta.url),
            ),
          },
        },
        test: {
          name: "request-binding",
          include: ["src/index-request-binding.test.ts"],
        },
      },
      {
        resolve: {
          alias: {
            ...sharedAlias,
            "cloudflare:workers": fileURLToPath(
              new URL(
                "../event-ingest-api/src/cloudflare-workers.test-fixture.ts",
                import.meta.url,
              ),
            ),
          },
        },
        test: {
          name: "event-ingest-seam",
          include: ["src/exposures-seam.test.ts"],
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "unit",
          include: ["src/**/*.{test,spec}.ts"],
          exclude: [
            ...configDefaults.exclude,
            "src/exposures-seam.test.ts",
            "src/index-request-binding.test.ts",
          ],
          // Direct Miniflare startup plus CPU contention from the parallel
          // Verify graph makes Vitest's 5s Node default flaky.
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
