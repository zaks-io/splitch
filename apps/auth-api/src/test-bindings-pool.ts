import { env } from "cloudflare:workers";
import { resetD1Database } from "@splitch/db/test-d1-pool";
import type { LocalBindings } from "./test-fixtures";

let leased = false;

/** Lease this test file's in-process bindings with empty D1 and KV storage. */
export async function makePoolBindings(): Promise<LocalBindings> {
  if (leased) throw new Error("test-bindings-pool: bindings are already leased in this test file");
  leased = true;

  const testEnv = env as typeof env & {
    DB: D1Database;
    JTI_CACHE: KVNamespace;
    SESSION_STORE: KVNamespace;
  };

  try {
    await resetD1Database(testEnv.DB);
    await resetPoolKv({ kv: testEnv.JTI_CACHE, sessionKv: testEnv.SESSION_STORE });
  } catch (error) {
    leased = false;
    throw error;
  }

  let disposed = false;
  return {
    d1: testEnv.DB,
    kv: testEnv.JTI_CACHE,
    sessionKv: testEnv.SESSION_STORE,
    dispose: async () => {
      if (disposed) throw new Error("test-bindings-pool: binding lease was already disposed");
      disposed = true;
      leased = false;
    },
  };
}

export async function resetPoolKv(
  bindings: Pick<LocalBindings, "kv" | "sessionKv">,
): Promise<void> {
  await Promise.all([clearKv(bindings.kv), clearKv(bindings.sessionKv)]);
}

async function clearKv(kv: KVNamespace): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor ? { cursor } : undefined);
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
