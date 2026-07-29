import { env } from "cloudflare:workers";
import { seedConfigGraph } from "../src/config-store-fixture-data";
import { buildHarness, type Harness, ids, USER_ID } from "../src/config-store-harness-core";
import { resetOrganizationGraph, seedAppMember } from "../src/test-seeds";

/**
 * The `config-store` fixture graph is a set of fixed IDs (one Organization, two Apps, two
 * Environments, a Flag with variants, configs, a targeting rule, an Experiment and
 * two Runs) that these suites then mutate heavily, so it is torn down and rebuilt
 * per test to give each one the clean slate a fresh Miniflare used to.
 */
export async function makePoolHarness(): Promise<Harness> {
  const d1 = env.DB;
  await resetOrganizationGraph(d1);
  await clearKv(env.CONFIG_STORE);
  await seedConfigGraph(d1);
  await seedAppMember(d1, { appId: ids.appId, userId: USER_ID, role: "owner" });

  return buildHarness({
    d1,
    kv: env.CONFIG_STORE,
    sessions: env.SESSION_STORE,
    dispose: async () => {},
  });
}

async function clearKv(kv: KVNamespace): Promise<void> {
  // `list` caps a page at 1,000 keys, so a single call would silently leave the
  // remainder behind and leak them into the next test.
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor ? { cursor } : undefined);
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
