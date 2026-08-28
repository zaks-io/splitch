import { appScope, createRepository, envScope } from "@splitch/db";
import { expect } from "vitest";
import { makeConfigStore } from "../src/config-store";
import { makeFixtureSigner } from "../src/fixture-signer";
import {
  type FlagDefinitionHarness,
  makeAppForRepo,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { resetOrganizationGraph, seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindingsWithConfig, type PoolBindingsWithConfig } from "./pool-bindings";

export const LIFECYCLE_ORG = {
  orgId: "org_flag_config_lifecycle",
  orgName: "Flag Config Lifecycle Co",
  appId: "app_existing_flag_config_lifecycle",
  appName: "Existing Flag Config Lifecycle App",
  appKey: "existing-flag-config-lifecycle",
};
const LIFECYCLE_OWNER = "user_flag_config_lifecycle_owner";

export interface LifecycleHarness extends FlagDefinitionHarness {
  bindings: PoolBindingsWithConfig;
}

/**
 * Mount the control plane over the pool bindings with a fresh Organization graph.
 *
 * The graph is reset because the pool isolates storage per test FILE, not per
 * test, and every consumer re-creates the same fixed-key App.
 */
export async function setup(): Promise<LifecycleHarness> {
  const bindings = await makePoolBindingsWithConfig();
  await resetOrganizationGraph(bindings.d1);
  await seedOrgApp(bindings.d1, LIFECYCLE_ORG);
  await seedOrgMember(bindings.d1, {
    orgId: LIFECYCLE_ORG.orgId,
    userId: LIFECYCLE_OWNER,
    role: "owner",
  });
  const signer = await makeFixtureSigner();
  return {
    bindings,
    signer,
    app: makeAppForRepo(
      { bindings, signer },
      createRepository(bindings.d1),
      configStoreAccess(bindings),
      bindings.credentialKv,
    ),
  };
}

export function configStoreAccess(bindings: PoolBindingsWithConfig) {
  const repo = createRepository(bindings.d1);
  const nudges: unknown[] = [];
  const store = makeConfigStore({
    repo,
    kv: bindings.configKv,
    broadcaster: { broadcast: (nudge) => void nudges.push(nudge) },
    now: () => new Date(Date.parse(NOW_ISO)),
  });
  return {
    writerFor: (_appId: string, _environmentId: string) => store,
    liveUpdatesFor: () => ({
      connect: async () => new Response("test live updates unavailable", { status: 503 }),
    }),
    nudges,
  };
}

export async function countFlagConfigs(
  repo: ReturnType<typeof createRepository>,
  appId: string,
): Promise<number> {
  const environments = await repo.identity.listEnvironments(appScope(appId));
  const counts = await Promise.all(
    environments.map((environment) =>
      repo.flags.flagConfigs.findMany(envScope(appId, environment.id)).then((rows) => rows.length),
    ),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

export async function lifecycleOrgToken(h: LifecycleHarness): Promise<string> {
  return h.signer.sign({
    sub: LIFECYCLE_OWNER,
    iss: "https://auth.splitch.test",
    aud: "https://cp.splitch.test",
    iat: Math.floor(Date.parse(NOW_ISO) / 1000),
    exp: Math.floor(Date.parse(NOW_ISO) / 1000) + 3600,
    scopes: [`org:${LIFECYCLE_ORG.orgId}:owner`],
  });
}

export async function lifecycleAppToken(h: LifecycleHarness, appId: string): Promise<string> {
  return h.signer.sign({
    sub: LIFECYCLE_OWNER,
    iss: "https://auth.splitch.test",
    aud: "https://cp.splitch.test",
    iat: Math.floor(Date.parse(NOW_ISO) / 1000),
    exp: Math.floor(Date.parse(NOW_ISO) / 1000) + 3600,
    scopes: [`app:${appId}:owner`],
  });
}

export async function lifecycleCreateDefaultApp(h: LifecycleHarness) {
  const res = await request(
    h,
    "POST",
    `/orgs/${LIFECYCLE_ORG.orgId}/apps`,
    await lifecycleOrgToken(h),
    {
      name: "Checkout",
      key: "checkout",
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
  };
}

export function faultingRepo(repo: ReturnType<typeof createRepository>, failOnAttempt: number) {
  let attempt = 0;
  const originalEnsure = repo.flags.ensureInitialFlagConfig.bind(repo.flags);
  repo.flags.ensureInitialFlagConfig = async (...args) => {
    attempt += 1;
    if (attempt === failOnAttempt) throw new Error("injected config init failure");
    return originalEnsure(...args);
  };
  return repo;
}

export function faultingCredentialProvisionKv(base: KVNamespace): KVNamespace {
  let puts = 0;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async (...args: Parameters<KVNamespace["put"]>) => {
          puts += 1;
          if (puts === 1) throw new Error("KV unavailable");
          return target.put(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function insertExperiment(
  repo: ReturnType<typeof createRepository>,
  scope: ReturnType<typeof envScope>,
  input: { id: string; flagId: string; key: string; status: "draft" | "ended" | "running" },
): Promise<void> {
  await repo.experiments.experiments.insert(scope, {
    id: input.id,
    appId: scope.appId,
    environmentId: scope.environmentId,
    key: input.key,
    flagId: input.flagId,
    name: input.key,
    status: input.status,
    targetingKeyField: "targetingKey",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}

export async function seedRunningFlagExperiment(
  repo: ReturnType<typeof createRepository>,
  appId: string,
  environmentId: string,
  flagId: string,
  suffix: string,
): Promise<void> {
  const scope = envScope(appId, environmentId);
  const experimentId = `exp_running_${suffix}`;
  const runId = `run_running_${suffix}`;
  await repo.experiments.experiments.insert(scope, {
    id: experimentId,
    appId,
    environmentId,
    key: `running-${suffix}`,
    flagId,
    name: `Running ${suffix}`,
    status: "running",
    targetingKeyField: "targetingKey",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: runId,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.runs.insert(scope, {
    id: runId,
    appId,
    environmentId,
    experimentId,
    runNumber: 1,
    status: "running",
    targetingKeyField: "targetingKey",
    targetingKeyType: "user",
    salt: `salt_${suffix}`,
    allocation: JSON.stringify({ control: 100 }),
    variantSet: JSON.stringify([
      { id: `variant_control_${suffix}`, name: "control", value: false },
    ]),
    controlVariantId: `variant_control_${suffix}`,
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: `hash_${suffix}`,
    startedAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
}
