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
    dispose: async () => {
      await Promise.all([
        clearKv(testEnv.SESSION_STORE),
        clearKv(testEnv.CREDENTIAL_STORE),
        clearKv(testEnv.CONFIG_STORE),
      ]);
    },
  };
}

export interface PoolBindingsWithConfig extends LocalBindings {
  configKv: KVNamespace;
}

export async function makePoolBindingsWithConfig(): Promise<PoolBindingsWithConfig> {
  const testEnv = env as TestEnv;
  return { ...(await makePoolBindings()), configKv: testEnv.CONFIG_STORE };
}

async function clearKv(kv: KVNamespace): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor ? { cursor } : undefined);
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
