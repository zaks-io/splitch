import { env } from "cloudflare:workers";
import type { LocalBindings } from "./test-fixtures";

type TestEnv = typeof env & {
  DB: D1Database;
  SESSION_STORE: KVNamespace;
  CREDENTIAL_STORE: KVNamespace;
  CONFIG_STORE: KVNamespace;
};

/** Return the in-process Workers bindings without creating a proxy server. */
export async function makePoolBindings(): Promise<LocalBindings> {
  const testEnv = env as TestEnv;
  return {
    d1: testEnv.DB,
    kv: testEnv.SESSION_STORE,
    credentialKv: testEnv.CREDENTIAL_STORE,
    dispose: async () => {},
  };
}

export interface PoolBindingsWithConfig extends LocalBindings {
  configKv: KVNamespace;
}

export async function makePoolBindingsWithConfig(): Promise<PoolBindingsWithConfig> {
  const testEnv = env as TestEnv;
  return { ...(await makePoolBindings()), configKv: testEnv.CONFIG_STORE };
}
