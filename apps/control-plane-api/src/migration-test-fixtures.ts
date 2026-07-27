import { migrationStatements } from "@splitch/db/test-d1";
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

async function applyMigrations(d1: D1Database): Promise<void> {
  for (const statement of migrationStatements()) {
    await d1.exec(statement);
  }
}
