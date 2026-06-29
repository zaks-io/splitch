import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the D1 schema. D1 is SQLite, so the `sqlite` dialect
 * generates the migration SQL set into ./migrations. `wrangler d1 migrations
 * apply --local` (scripts/check-d1-local.mjs) then applies that same set to a
 * local Miniflare D1, which is the fail-loud gate — a malformed migration must
 * fail the apply non-zero, not be skipped.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
