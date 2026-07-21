import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
          workers: [
            {
              name: "splitch-analysis-api",
              modules: true,
              script: `
                import { WorkerEntrypoint } from "cloudflare:workers";

                export class ControlPlaneEntrypoint extends WorkerEntrypoint {}
              `,
            },
          ],
        },
      }),
    ],
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
      include: ["test/**/*.{test,spec}.ts"],
      passWithNoTests: true,
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
