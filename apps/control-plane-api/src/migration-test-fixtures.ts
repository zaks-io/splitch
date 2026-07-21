import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

export interface MigratedLocalBindings {
  d1: D1Database;
  kv: KVNamespace;
  credentialKv: KVNamespace;
  configKv: KVNamespace;
  dispose: () => Promise<void>;
}

export async function makeMigratedLocalBindings(): Promise<MigratedLocalBindings> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: {
      SESSION_STORE: "sessions",
      CREDENTIAL_STORE: "credentials",
      CONFIG_STORE: "config",
    },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  const kv = (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace;
  const credentialKv = (await mf.getKVNamespace("CREDENTIAL_STORE")) as unknown as KVNamespace;
  const configKv = (await mf.getKVNamespace("CONFIG_STORE")) as unknown as KVNamespace;
  await applyMigrations(d1);
  return { d1, kv, credentialKv, configKv, dispose: () => mf.dispose() };
}

export async function applyMigrations(d1: D1Database): Promise<void> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "db",
    "migrations",
  );
  const sql = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
    .join("\n");
  for (const statement of sql
    .split(/-->\s*statement-breakpoint/)
    .flatMap((chunk) => chunk.split(";"))
    .map((statement) => statement.trim())
    .filter(Boolean)) {
    await d1.exec(statement.replace(/\n/g, " "));
  }
}
