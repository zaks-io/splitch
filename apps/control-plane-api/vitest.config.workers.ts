import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { D1_TEST_FILES } from "./vitest.d1-tests";

/**
 * Every `services` binding in wrangler.jsonc must resolve or the pool refuses to
 * start the whole suite, so each delegation target this Worker forwards to needs
 * a stand-in here (ADR-0046). Keep in step with wrangler.jsonc: a missing one
 * reads as "no such service is defined", which names Miniflare rather than the
 * route that was added.
 */
const DELEGATION_TARGETS = ["splitch-analysis-api", "splitch-evaluation-api"];

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(fileURLToPath(new URL(".", import.meta.url)), "../../packages/db/migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          workers: DELEGATION_TARGETS.map((name) => ({
            name,
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";

              export class ControlPlaneEntrypoint extends WorkerEntrypoint {}
            `,
          })),
        },
      }),
    ],
    resolve: {
      alias: {
        "@splitch/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url)
          .pathname,
        // Ordered before the bare "@splitch/db" alias: that one is a prefix match
        // and would otherwise rewrite the subpath into `index.ts/test-d1`.
        "@splitch/db/test-d1-pool": new URL(
          "../../packages/db/src/repo/test-d1-pool.ts",
          import.meta.url,
        ).pathname,
        "@splitch/db/test-d1": new URL("../../packages/db/src/repo/test-d1.ts", import.meta.url)
          .pathname,
        "@splitch/db": new URL("../../packages/db/src/index.ts", import.meta.url).pathname,
        "@splitch/privacy": new URL("../../packages/privacy/src/index.ts", import.meta.url)
          .pathname,
        "@splitch/worker-runtime": new URL(
          "../../packages/worker-runtime/src/index.ts",
          import.meta.url,
        ).pathname,
      },
    },
    test: {
      name: "workers",
      include: ["test/**/*.{test,spec}.ts", ...D1_TEST_FILES],
      setupFiles: ["./test/apply-migrations.ts"],
      // Miniflare startup plus CPU contention from the parallel verify graph
      // makes the 5s default flaky (SPL-231).
      testTimeout: 15_000,
      hookTimeout: 30_000,
    },
  };
});
