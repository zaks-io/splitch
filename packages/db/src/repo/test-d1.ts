import { readdirSync, readFileSync } from "node:fs";
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
  return migrationFiles().flatMap(migrationFileStatements);
}

export function migrationStatementsThrough(lastFile: string): string[] {
  const sqlFiles = migrationFiles();
  const lastIndex = sqlFiles.indexOf(lastFile);
  if (lastIndex < 0) throw new Error(`test-d1: migration not found: ${lastFile}`);
  return sqlFiles.slice(0, lastIndex + 1).flatMap(migrationFileStatements);
}

export function migrationFileStatements(fileName: string): string[] {
  if (!migrationFiles().includes(fileName)) {
    throw new Error(`test-d1: migration not found: ${fileName}`);
  }
  const sql = readFileSync(join(migrationsDir, fileName), "utf8");
  // drizzle-kit separates statements with a breakpoint marker; split on it and
  // fall back to `;` so a single exec failure surfaces the offending statement.
  // Comments come off BEFORE the `;` fallback: a semicolon inside a rationale
  // comment would otherwise split it into a chunk with no `--` left on the
  // second half, handing d1.exec prose to run as SQL.
  return (
    sql
      .split(/-->\s*statement-breakpoint/)
      .map(stripLineComments)
      .flatMap(splitMigrationChunk)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      // `d1.exec` treats each line as its own statement, so a multi-line one must
      // be flattened before it is handed over.
      .map((s) => s.replace(/\n/g, " "))
  );
}

function splitMigrationChunk(chunk: string): string[] {
  if (/^\s*CREATE\s+TRIGGER\b/i.test(chunk)) {
    return [chunk.replace(/;\s*$/, "")];
  }
  return chunk.split(";");
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/**
 * `d1.exec` takes one statement per call and rejects a leading comment block, so
 * the rationale comments migrations carry have to come off here. `wrangler d1
 * migrations apply` (the real gate) strips them itself.
 *
 * Scans character by character so a `--` inside a string literal stays SQL. A
 * line-oriented strip would eat the rest of `VALUES ('email--digest')`.
 */
function stripLineComments(statement: string): string {
  let out = "";
  let i = 0;
  while (i < statement.length) {
    const char = statement[i];
    if (char === "'") {
      const literal = readStringLiteral(statement, i);
      out += literal.text;
      i = literal.end;
      continue;
    }
    if (char === "-" && statement[i + 1] === "-") {
      const newline = statement.indexOf("\n", i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    out += char;
    i += 1;
  }
  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/**
 * Read the single-quoted literal starting at `start`, doubled quotes included.
 *
 * `end` is the index just past the closing quote. An unterminated literal means
 * the migration is malformed, so it throws rather than guessing where it ends.
 */
function readStringLiteral(statement: string, start: number): { text: string; end: number } {
  let i = start + 1;
  while (i < statement.length) {
    if (statement[i] === "'") {
      // '' is an escaped quote inside the literal, not the end of one.
      if (statement[i + 1] === "'") {
        i += 2;
        continue;
      }
      return { text: statement.slice(start, i + 1), end: i + 1 };
    }
    i += 1;
  }
  throw new Error(`test-d1: unterminated string literal in migration statement:\n${statement}`);
}

/**
 * Apply a schema to a local D1 in ONE round-trip.
 *
 * Miniflare's D1 is a real workerd process reached over loopback, and `d1.exec`
 * opens a fresh connection per call that lands in TIME_WAIT. Looping it over the
 * migration set cost one ephemeral port per statement, which is how the suite
 * used to exhaust macOS's 16k-port range and fail with EADDRNOTAVAIL. `batch`
 * sends the whole array as a single request, so setup costs one port instead of
 * one-per-statement.
 */
export async function applySchema(d1: D1Database, statements: string[]): Promise<void> {
  await d1.batch(statements.map((statement) => d1.prepare(statement)));
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

  await applySchema(d1, migrationStatements());

  return {
    d1,
    dispose: () => mf.dispose(),
  };
}
