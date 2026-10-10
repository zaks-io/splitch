import { applySchema, migrationStatements } from "@splitch/db/test-migrations";
import { Miniflare } from "miniflare";

export interface LocalBindings {
  d1: D1Database;
  kv: KVNamespace;
  credentialKv: KVNamespace;
  dispose: () => Promise<void>;
}

export async function makeLocalBindings(): Promise<LocalBindings> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: { SESSION_STORE: "sessions", CREDENTIAL_STORE: "credentials" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  const kv = (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace;
  const credentialKv = (await mf.getKVNamespace("CREDENTIAL_STORE")) as unknown as KVNamespace;
  await applySchema(d1, migrationStatements());
  return { d1, kv, credentialKv, dispose: () => mf.dispose() };
}
