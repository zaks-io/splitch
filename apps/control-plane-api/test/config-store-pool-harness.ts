import { env } from "cloudflare:workers";
import { seedConfigGraph } from "../src/config-store-fixture-data";
import { buildHarness, type Harness, ids, USER_ID } from "../src/config-store-harness-core";
import { seedAppMember } from "../src/test-seeds";

/**
 * The `config-store` fixture graph is a set of fixed IDs (one Org, two Apps, two
 * Environments, a Flag with variants, configs, a targeting rule, an Experiment and
 * two Runs) that these suites then mutate heavily. The Workers pool isolates
 * storage per test FILE rather than per test (isolatedStorage was dropped in the
 * Vitest 4 migration, workers-sdk#12889), so the graph has to be torn down and
 * rebuilt per test to give each one the clean slate a fresh Miniflare used to.
 *
 * Deletes are ordered children-before-parents because these are real foreign
 * keys, and go out as one `batch` so the reset costs a single round-trip.
 */
const RESET_TABLES = [
  "runs",
  "experiments",
  "targeting_rules",
  "flag_configs",
  "variants",
  "flags",
  "environments",
  "app_memberships",
  "apps",
  "org_memberships",
  "organizations",
];

export async function makePoolHarness(): Promise<Harness> {
  const d1 = env.DB;
  await d1.batch(RESET_TABLES.map((table) => d1.prepare(`DELETE FROM ${table}`)));
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
