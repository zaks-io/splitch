import type { StatsOutput } from "@splitch/contracts";
import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, type Mock, vi } from "vitest";
import { createApp } from "./app";
import type { AnalysisResultsReader } from "./attention-rollup";
import { ids, NOW, seedConfigGraph } from "./config-store-fixture-data";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";

export const USER_ID = "user_attention";
export const OTHER_APP_ID = "app_other_attention";
export const DEV_EXPERIMENT_ID = "exp_attention_dev";
export const QA_ENVIRONMENT_ID = "env_qa";
const allowLimiter: RateLimiter = () => ({ limited: false });

/**
 * Every test here boots a real local harness (Miniflare + D1 migrations) in
 * beforeEach, and the fan-out cases seed hundreds of rows through it. That costs
 * well over the 5s vitest default on a loaded CI runner.
 */
export const ATTENTION_TEST_TIMEOUT = 60_000;

let bindings: LocalBindings;

/** The App under test: two seeded Environments plus QA, one running Run in dev. */
export function setupAttentionRollupFixture(): void {
  beforeEach(async () => {
    bindings = await makeLocalBindings();
    await seedConfigGraph(bindings.d1);
    const repo = createRepository(bindings.d1);
    await repo.identity.createAppMembership({
      appId: ids.appId,
      userId: USER_ID,
      role: "member",
      createdAt: NOW,
    });
    await repo.identity.createOrgMembership({
      orgId: ids.orgId,
      userId: USER_ID,
      role: "member",
      createdAt: NOW,
    });
    await repo.identity.environments.insert(appScope(ids.appId), {
      id: QA_ENVIRONMENT_ID,
      appId: ids.appId,
      key: "qa",
      name: "QA",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.experiments.experiments.insert(envScope(ids.appId, ids.devEnvironmentId), {
      id: DEV_EXPERIMENT_ID,
      appId: ids.appId,
      environmentId: ids.devEnvironmentId,
      key: "attention-dev",
      flagId: ids.flagId,
      name: "Dev attention",
      status: "running",
      targetingKeyField: "userId",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      liveRunId: "run_attention_dev",
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(async () => bindings.dispose());
}

export function repository(): Repository {
  return createRepository(bindings.d1);
}

export interface EnvironmentAttentionItem {
  environmentId: string;
  state: string;
  srm: boolean;
  guardrail: boolean;
}

export function itemFor(items: EnvironmentAttentionItem[], environmentId: string) {
  const item = items.find((candidate) => candidate.environmentId === environmentId);
  if (!item) throw new Error(`rollup is missing Environment ${environmentId}`);
  return item;
}

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

/** A fully separate tenant: its own Organization, App, Environment and running Run. */
export async function seedOtherTenant(repo: Repository) {
  const orgId = "org_other_tenant";
  const appId = "app_other_tenant";
  const environmentId = "env_other_tenant";
  const flagId = "flag_other_tenant";
  const scope = appScope(appId);
  await repo.identity.createOrganization({
    organization: {
      id: orgId,
      name: "Other Tenant",
      slug: "other-tenant",
      plan: "free",
      createdAt: NOW,
      updatedAt: NOW,
    },
    ownerUserId: "user_other_tenant_owner",
    createdAt: NOW,
  });
  await repo.identity.createApp({
    id: appId,
    organizationId: orgId,
    name: "Other Tenant App",
    key: "other-tenant-app",
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
    key: "other-tenant-flag",
    name: "Other tenant flag",
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
    id: "exp_other_tenant",
    appId,
    environmentId,
    key: "other-tenant-experiment",
    flagId,
    name: "Other tenant experiment",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: "run_other_tenant",
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { orgId, appId, environmentId };
}

/** `repo` is injectable so a test can spy on which D1 reads the handler issues. */
export function harness(
  analysisResults: AnalysisResultsReader,
  authResolver: AuthResolver,
  repo: Repository = createRepository(bindings.d1),
) {
  return createApp({ authResolver, rateLimiter: allowLimiter, repo, analysisResults });
}

/** Counts the per-Environment planning read, which must not run once a budget refuses. */
export function spyOnPlanningReads(repo: Repository): {
  spied: Repository;
  listRunningExperiments: Mock<Repository["experiments"]["listRunningExperiments"]>;
} {
  const listRunningExperiments = vi.fn(
    repo.experiments.listRunningExperiments.bind(repo.experiments),
  );
  const spied: Repository = {
    ...repo,
    experiments: { ...repo.experiments, listRunningExperiments },
  };
  return { spied, listRunningExperiments };
}

export function authFor(appId: string, userId: string): AuthResolver {
  return async () => ({ ok: true, principal: principal(appId, userId) });
}

function principal(appId: string, userId: string): Principal {
  return {
    kind: "control-plane-token",
    id: userId,
    scopes: [`app:${appId}:member`],
    orgId: null,
    appId,
    environmentId: null,
    authDoor: "id_jag",
  };
}

export function statsOutput(
  input: { srm?: boolean; guardrail?: boolean; activationBalance?: boolean } = {},
): StatsOutput {
  return {
    arm_results: [],
    srm: {
      srm_p_value: input.srm ? 0.0001 : 0.5,
      srm_is_mismatch: input.srm ?? false,
      observed_counts: { control: 10, treatment: 10 },
      expected_counts: { control: 10, treatment: 10 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: input.guardrail
      ? [
          {
            metric_id: "metric_guardrail",
            variant: "treatment",
            ci_lower: -0.2,
            threshold: -0.1,
            is_breached: true,
            in_bh_family: false,
            exploratory: false,
            decision_valid: true,
            breach_reason: "lower confidence bound crossed threshold",
          },
        ]
      : [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: input.activationBalance ? 0.0001 : null,
      activation_balance_mismatch: input.activationBalance ?? null,
      exposure_counts: { control: 10, treatment: 10 },
      deduped_counts: { control: 10, treatment: 10 },
      low_n_warning: false,
    },
  };
}
