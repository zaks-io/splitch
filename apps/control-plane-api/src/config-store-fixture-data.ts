import { appScope, createRepository, envScope, type Repository } from "@splitch/db";

export const NOW = "2026-07-01T20:00:00.000Z";
export const NOW_MS = Date.parse(NOW);

export const ids = {
  orgId: "org_config",
  appId: "app_config",
  otherAppId: "app_config_other",
  environmentId: "env_prod",
  flagId: "flag_checkout",
  flagKey: "checkout-redesign",
  configId: "flag_config_checkout_prod",
  controlVariantId: "var_control",
  treatmentVariantId: "var_treatment",
  experimentId: "exp_checkout",
  liveRunId: "run_live",
  newerRunId: "run_newer_not_live",
};

export async function seedConfigGraph(d1: D1Database): Promise<void> {
  const repo = createRepository(d1);
  const aScope = appScope(ids.appId);
  const eScope = envScope(ids.appId, ids.environmentId);
  await repo.identity.createOrganization({
    id: ids.orgId,
    name: "Config Org",
    plan: "free",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.identity.createApp({
    id: ids.appId,
    organizationId: ids.orgId,
    name: "Config App",
    key: "config-app",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.identity.createApp({
    id: ids.otherAppId,
    organizationId: ids.orgId,
    name: "Other Config App",
    key: "other-config-app",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.identity.environments.insert(aScope, {
    id: ids.environmentId,
    appId: ids.appId,
    key: "production",
    name: "Production",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.flags.insert(aScope, {
    id: ids.flagId,
    appId: ids.appId,
    key: ids.flagKey,
    name: "Checkout redesign",
    defaultVariantId: ids.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.addVariant(aScope, ids.flagId, {
    id: ids.controlVariantId,
    name: "control",
    value: JSON.stringify("off"),
    createdAt: NOW,
  });
  await repo.flags.addVariant(aScope, ids.flagId, {
    id: ids.treatmentVariantId,
    name: "treatment",
    value: JSON.stringify("on"),
    createdAt: NOW,
  });
  await repo.flags.flagConfigs.insert(eScope, {
    id: ids.configId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: ids.flagId,
    enabled: false,
    availableVariantNames: JSON.stringify(["control", "treatment"]),
    defaultVariantId: ids.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.experiments.experiments.insert(eScope, {
    id: ids.experimentId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    key: "checkout-exp",
    flagId: ids.flagId,
    name: "Checkout experiment",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: ids.liveRunId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await insertRun(repo, ids.liveRunId, 1, "2026-07-01T19:00:00.000Z");
  await insertRun(repo, ids.newerRunId, 2, "2026-07-01T19:30:00.000Z");
}

async function insertRun(repo: Repository, runId: string, runNumber: number, startedAt: string) {
  const variants = [
    { id: ids.controlVariantId, name: "control", value: "off" },
    { id: ids.treatmentVariantId, name: "treatment", value: "on" },
  ];
  await repo.experiments.runs.insert(envScope(ids.appId, ids.environmentId), {
    id: runId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    experimentId: ids.experimentId,
    runNumber,
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: `salt_${runId}`,
    allocation: JSON.stringify({ control: 50, treatment: 50 }),
    variantSet: JSON.stringify(variants),
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: `hash_${runId}`,
    startedAt,
    createdAt: startedAt,
  });
}
