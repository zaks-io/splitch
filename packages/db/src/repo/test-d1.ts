import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

/**
 * Local D1 fixture for the repository suite.
 *
 * Uses Miniflare's REAL local D1 (the same SQLite engine `wrangler d1 ... --local`
 * runs) and applies the GENERATED migration SQL — not a hand-rolled CREATE TABLE.
 * So the isolation test exercises the actual emitted schema the seam queries,
 * which is the only honest substrate for a tenant-isolation proof.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

function migrationStatements(): string[] {
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = sqlFiles.map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n");
  // drizzle-kit separates statements with a breakpoint marker; split on it and
  // fall back to `;` so a single exec failure surfaces the offending statement.
  return sql
    .split(/-->\s*statement-breakpoint/)
    .flatMap((chunk) => chunk.split(";"))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type LocalD1 = {
  d1: D1Database;
  dispose: () => Promise<void>;
};

/** Spin up a fresh in-memory local D1 with the full migration set applied. */
export async function createLocalD1(): Promise<LocalD1> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;

  for (const statement of migrationStatements()) {
    await d1.exec(statement.replace(/\n/g, " "));
  }

  return {
    d1,
    dispose: () => mf.dispose(),
  };
}
