import { appScope, createRepository, envScope } from "../index";

/**
 * Seed two complete tenant graphs (App A, App B) into one local D1.
 *
 * Tenant-scoped rows are inserted through the SAME scope-bound repository the
 * test then reads from — so the seed also exercises that inserts stamp the
 * caller's scope. The non-tenant ROOTS (organizations, apps) are inserted with a
 * direct prepared statement: they are above the App tenant boundary and the
 * repository deliberately exposes no app-scoped insert for them.
 */

const NOW = "2026-06-28T00:00:00.000Z";

type Tenant = {
  orgId: string;
  appId: string;
  environmentId: string;
  flagId: string;
  variantId: string;
  experimentId: string;
  runId: string;
  apiKeyId: string;
  // DISTINCT human-facing keys per tenant. If A and B shared a `key`, a
  // cross-tenant MOVE (rewriting app_id to B's, keeping the key) would collide
  // with B's existing (app_id, key) UNIQUE index and LOOK blocked — the schema
  // would accidentally mask a write-isolation regression. Distinct keys mean any
  // breach surfaces as actual cross-tenant data, not a unique-constraint error.
  flagKey: string;
  envKey: string;
  experimentKey: string;
};

function ids(p: string): Tenant {
  return {
    orgId: `org_${p}`,
    appId: `app_${p}`,
    environmentId: `env_${p}`,
    flagId: `flag_${p}`,
    variantId: `var_${p}`,
    experimentId: `exp_${p}`,
    runId: `run_${p}`,
    apiKeyId: `key_${p}`,
    flagKey: `flag-key-${p}`,
    envKey: `env-key-${p}`,
    experimentKey: `exp-key-${p}`,
  };
}

async function insertRoots(d1: D1Database, t: Tenant): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    // Slug defaults to the id, exactly like migration 0014's backfill: unique per
    // tenant without these tests having to invent a handle they never assert on.
    .bind(t.orgId, `org ${t.orgId}`, t.orgId, "free", NOW, NOW)
    .run();
  await d1
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(t.appId, t.orgId, `app ${t.appId}`, t.appId, NOW, NOW)
    .run();
}

async function seedTenant(repo: ReturnType<typeof createRepository>, t: Tenant): Promise<void> {
  const aScope = appScope(t.appId);
  const eScope = envScope(t.appId, t.environmentId);

  await repo.identity.environments.insert(aScope, {
    id: t.environmentId,
    appId: t.appId,
    key: t.envKey,
    name: "Production",
    createdAt: NOW,
    updatedAt: NOW,
  });

  await repo.flags.flags.insert(aScope, {
    id: t.flagId,
    appId: t.appId,
    key: t.flagKey,
    name: "A Flag",
    createdAt: NOW,
    updatedAt: NOW,
  });

  await repo.flags.addVariant(aScope, t.flagId, {
    id: t.variantId,
    name: "control",
    value: '"control"',
    createdAt: NOW,
  });

  await repo.experiments.experiments.insert(eScope, {
    id: t.experimentId,
    appId: t.appId,
    environmentId: t.environmentId,
    key: t.experimentKey,
    flagId: t.flagId,
    name: "An Experiment",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    createdAt: NOW,
    updatedAt: NOW,
  });

  await repo.experiments.runs.insert(eScope, {
    id: t.runId,
    appId: t.appId,
    environmentId: t.environmentId,
    experimentId: t.experimentId,
    runNumber: 1,
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: `salt_${t.runId}`,
    allocation: '{"control":100}',
    variantSet: JSON.stringify([{ id: t.variantId, name: "control", value: "control" }]),
    controlVariantId: t.variantId,
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: `hash_${t.runId}`,
    startedAt: NOW,
    createdAt: NOW,
  });

  await repo.credentials.apiKeys.insert(eScope, {
    keyId: t.apiKeyId,
    appId: t.appId,
    environmentId: t.environmentId,
    keyHash: `hash_${t.apiKeyId}`,
    scopes: "[]",
    createdAt: NOW,
  });
}

export type SeededTenants = { a: Tenant; b: Tenant };

/**
 * A second Environment under an EXISTING tenant's App.
 *
 * `seedTwoTenants` alone cannot prove Environment scoping: tenant B differs on
 * `app_id` AND `environment_id`, so a query filtering on only one of the two
 * still excludes it and the other predicate is unproven. A sibling Environment
 * differs on `environment_id` alone, so deleting that predicate leaks it.
 */
export async function seedSiblingEnvironment(
  d1: D1Database,
  tenant: { appId: string; envKey: string },
  environmentId: string,
): Promise<void> {
  await createRepository(d1).identity.environments.insert(appScope(tenant.appId), {
    id: environmentId,
    appId: tenant.appId,
    key: `${tenant.envKey}-sibling`,
    name: "Staging",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export async function seedTwoTenants(d1: D1Database): Promise<SeededTenants> {
  const repo = createRepository(d1);
  const a = ids("a");
  const b = ids("b");
  for (const t of [a, b]) {
    await insertRoots(d1, t);
    await seedTenant(repo, t);
  }
  return { a, b };
}
