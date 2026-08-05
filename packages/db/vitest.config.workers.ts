import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { D1_TEST_FILES } from "./vitest.d1-tests";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(fileURLToPath(new URL(".", import.meta.url)), "migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-06-21",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "splitch-db-test" },
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      name: "workers",
      include: D1_TEST_FILES,
      passWithNoTests: true,
      setupFiles: ["./src/repo/test-d1-pool-setup.ts"],
      hookTimeout: 30_000,
      testTimeout: 15_000,
    },
  };
});
