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

/**
 * The migration set as individual `d1.exec`-ready statements.
 *
 * Exported because the Worker test harnesses need the identical parse: three
 * hand-copied splitters previously drifted, and the first migration to carry a
 * comment broke every one of them separately.
 */
export function migrationStatements(): string[] {
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = sqlFiles.map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n");
  // drizzle-kit separates statements with a breakpoint marker; split on it and
  // fall back to `;` so a single exec failure surfaces the offending statement.
  return (
    sql
      .split(/-->\s*statement-breakpoint/)
      .flatMap((chunk) => chunk.split(";"))
      .map(stripLineComments)
      .filter((s) => s.length > 0)
      // `d1.exec` treats each line as its own statement, so a multi-line one must
      // be flattened before it is handed over.
      .map((s) => s.replace(/\n/g, " "))
  );
}

/**
 * `d1.exec` takes one statement per call and rejects a leading comment block, so
 * the rationale comments migrations carry have to come off here. `wrangler d1
 * migrations apply` (the real gate) strips them itself.
 *
 * A `--` inside a string literal would be a comment to this stripper and SQL to
 * SQLite, so that case throws rather than silently mangling the statement.
 */
function stripLineComments(statement: string): string {
  if (/'[^']*--/.test(statement)) {
    throw new Error(
      `test-d1: cannot strip comments from a statement containing "--" in a string literal:\n${statement}`,
    );
  }
  return statement
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
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
    await d1.exec(statement);
  }

  return {
    d1,
    dispose: () => mf.dispose(),
  };
}
