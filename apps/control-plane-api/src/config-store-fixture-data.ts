import { appScope, createRepository, envScope, type Repository } from "@splitch/db";

export const NOW = "2026-07-01T20:00:00.000Z";
export const NOW_MS = Date.parse(NOW);

export const ids = {
  orgId: "org_config",
  appId: "app_config",
  otherAppId: "app_config_other",
  environmentId: "env_prod",
  devEnvironmentId: "env_dev",
  flagId: "flag_checkout",
  flagKey: "checkout-redesign",
  configId: "flag_config_checkout_prod",
  devConfigId: "flag_config_checkout_dev",
  devTargetingRuleId: "rule_checkout_dev_treatment",
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
    organization: {
      id: ids.orgId,
      name: "Config Org",
      slug: "config-org",
      plan: "free",
      createdAt: NOW,
      updatedAt: NOW,
    },
    ownerUserId: "user_config_owner",
    createdAt: NOW,
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
    id: ids.devEnvironmentId,
    appId: ids.appId,
    key: "dev",
    name: "Development",
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
    // `ensureInitialFlagConfig` ships `[]` (never narrowed = whole catalog
    // servable), so the fixture ships it too. A fixture that pre-narrows every
    // Configuration hides the default the code actually writes.
    availableVariantNames: JSON.stringify([]),
    defaultVariantId: ids.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.flagConfigs.insert(envScope(ids.appId, ids.devEnvironmentId), {
    id: ids.devConfigId,
    appId: ids.appId,
    environmentId: ids.devEnvironmentId,
    flagId: ids.flagId,
    enabled: true,
    availableVariantNames: JSON.stringify([]),
    defaultVariantId: ids.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.targetingRules.insert(envScope(ids.appId, ids.devEnvironmentId), {
    id: ids.devTargetingRuleId,
    appId: ids.appId,
    environmentId: ids.devEnvironmentId,
    flagId: ids.flagId,
    priority: 0,
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "pro" }]),
    variantId: ids.treatmentVariantId,
    percentageRollout: JSON.stringify({ percentage: 25, salt: "dev-rollout" }),
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
    // Draft by default, started explicitly by the suites that are ABOUT a live
    // Run. A live Run freezes this Flag's availability, baseline rollout, and
    // Targeting in this Environment (flag-config-run-freeze.ts), so a fixture
    // that ships one running would make every unrelated config-write test
    // negotiate a refusal that has nothing to do with what it asserts.
    status: "draft",
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

/**
 * Spell out the seeded Configurations' available Variant set. The fixture ships
 * `[]` because that is what `ensureInitialFlagConfig` writes, so a suite that
 * exercises availability ITSELF has to narrow explicitly: the rollout-ambiguity
 * gate, promotion diffs, the KV read projection, and targeting-rule writes,
 * which still read the column literally rather than through the
 * empty-means-all rule (SPL-201).
 */
export async function narrowSeededAvailability(
  d1: D1Database,
  names: string[] = ["control", "treatment"],
): Promise<void> {
  await d1
    .prepare("UPDATE flag_configs SET available_variant_names = ? WHERE app_id = ?")
    .bind(JSON.stringify(names), ids.appId)
    .run();
}

/**
 * Put the seeded Experiment into the state where `run_live` is actually live.
 *
 * Explicit rather than seeded so a suite that depends on a running Experiment
 * says so in its own setup, and so the freeze it implies is never a surprise.
 */
export async function startSeededExperiment(d1: D1Database): Promise<void> {
  await d1
    .prepare("UPDATE experiments SET status = 'running' WHERE app_id = ? AND id = ?")
    .bind(ids.appId, ids.experimentId)
    .run();
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
    controlVariantId: ids.controlVariantId,
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: `hash_${runId}`,
    startedAt,
    createdAt: startedAt,
  });
}
