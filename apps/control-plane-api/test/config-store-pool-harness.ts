import { env } from "cloudflare:workers";
import { seedConfigGraph } from "../src/config-store-fixture-data";
import { buildHarness, type Harness, ids, USER_ID } from "../src/config-store-harness-core";
import { resetTenantGraph, seedAppMember } from "../src/test-seeds";

/**
 * The `config-store` fixture graph is a set of fixed IDs (one Org, two Apps, two
 * Environments, a Flag with variants, configs, a targeting rule, an Experiment and
 * two Runs) that these suites then mutate heavily, so it is torn down and rebuilt
 * per test to give each one the clean slate a fresh Miniflare used to.
 */
export async function makePoolHarness(): Promise<Harness> {
  const d1 = env.DB;
  await resetTenantGraph(d1);
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
  const { keys } = await kv.list();
  await Promise.all(keys.map((key) => kv.delete(key.name)));
}
