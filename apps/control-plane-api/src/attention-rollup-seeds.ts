import { appScope, envScope, type Repository } from "@splitch/db";
import { ids, NOW } from "./config-store-fixture-data";

/** Row seeding for the attention-rollup suites: bulk fan-out, corrupt rows, second Organization. */
export async function seedRunningExperiments(
  repo: Repository,
  environmentId: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await repo.experiments.experiments.insert(envScope(ids.appId, environmentId), {
      id: `exp_bulk_${environmentId}_${index}`,
      appId: ids.appId,
      environmentId,
      key: `bulk-${index}`,
      flagId: ids.flagId,
      name: `Bulk ${index}`,
      status: "running",
      targetingKeyField: "userId",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      liveRunId: `run_bulk_${environmentId}_${index}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

/** Environments with no Experiments, to exercise the pre-planning Environment budget. */
export async function seedEnvironments(repo: Repository, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await repo.identity.environments.insert(appScope(ids.appId), {
      id: `env_bulk_${index}`,
      appId: ids.appId,
      key: `bulk-${index}`,
      name: `Bulk ${index}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

/** A second Organization, with its own App, Environment and running Run. */
export async function seedOtherOrganization(repo: Repository) {
  const orgId = "org_other_org";
  const appId = "app_other_org";
  const environmentId = "env_other_org";
  const flagId = "flag_other_org";
  const scope = appScope(appId);
  await repo.identity.createOrganization({
    organization: {
      id: orgId,
      name: "Other Organization",
      slug: "other-org",
      plan: "free",
      createdAt: NOW,
      updatedAt: NOW,
    },
    ownerUserId: "user_other_org_owner",
    createdAt: NOW,
  });
  await repo.identity.createApp({
    id: appId,
    organizationId: orgId,
    name: "Other Organization App",
    key: "other-org-app",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.identity.environments.insert(scope, {
    id: environmentId,
    appId,
    key: "production",
    name: "Production",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.flags.insert(scope, {
    id: flagId,
    appId,
    key: "other-org-flag",
    name: "Other Organization flag",
    defaultVariantId: "var_other_control",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.addVariant(scope, flagId, {
    id: "var_other_control",
    name: "control",
    value: JSON.stringify("off"),
    createdAt: NOW,
  });
  await repo.experiments.experiments.insert(envScope(appId, environmentId), {
    id: "exp_other_org",
    appId,
    environmentId,
    key: "other-org-experiment",
    flagId,
    name: "Other Organization experiment",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: "run_other_org",
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { orgId, appId, environmentId };
}

/** `repo` is injectable so a test can spy on which D1 reads the handler issues. */

/** A `running` Experiment with no live Run: a corrupt row, not an Analysis outage. */
export async function seedRunningExperimentWithoutRun(
  repo: Repository,
  environmentId: string,
): Promise<string> {
  const id = "exp_no_live_run";
  await repo.experiments.experiments.insert(envScope(ids.appId, environmentId), {
    id,
    appId: ids.appId,
    environmentId,
    key: "no-live-run",
    flagId: ids.flagId,
    name: "No live Run",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}
