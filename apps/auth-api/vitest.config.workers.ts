import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { D1_TEST_FILES } from "./vitest.d1-tests";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(fileURLToPath(new URL(".", import.meta.url)), "../../packages/db/migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-06-21",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "splitch-auth-api-test" },
          kvNamespaces: { JTI_CACHE: "jti", SESSION_STORE: "sessions" },
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      name: "workers",
      include: D1_TEST_FILES,
      setupFiles: ["./src/test-bindings-pool-setup.ts"],
      hookTimeout: 30_000,
      testTimeout: 15_000,
    },
  };
});
