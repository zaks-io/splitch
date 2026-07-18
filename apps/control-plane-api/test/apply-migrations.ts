import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

type TestEnv = typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
