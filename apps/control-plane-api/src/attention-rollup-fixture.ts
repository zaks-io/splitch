import type { StatsOutput } from "@splitch/contracts";
import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, type Mock, vi } from "vitest";
import { createApp } from "./app";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import { ids, NOW, seedConfigGraph, startSeededExperiment } from "./config-store-fixture-data";
import type { LocalBindings } from "./test-fixtures";

export const USER_ID = "user_attention";
export const OTHER_APP_ID = "app_other_attention";
export const DEV_EXPERIMENT_ID = "exp_attention_dev";
export const QA_ENVIRONMENT_ID = "env_qa";
const allowLimiter: RateLimiter = () => ({ limited: false });

/**
 * The fan-out cases seed hundreds of rows, so they retain a larger timeout for
 * loaded CI runners even though D1 now comes from the in-process Workers pool.
 */
export const ATTENTION_TEST_TIMEOUT = 60_000;

let bindings: LocalBindings;

/** The App under test: two seeded Environments plus QA, one running Run in dev. */
export function setupAttentionRollupFixture(): void {
  beforeEach(async () => {
    const [{ makePoolBindings }, { resetD1Database }] = await Promise.all([
      import("./test-bindings-pool"),
      import("@splitch/db/test-d1-pool"),
    ]);
    bindings = await makePoolBindings();
    await resetD1Database(bindings.d1);
    await seedConfigGraph(bindings.d1);
    // Attention is about work in flight, so the seeded prod Experiment has to be
    // actually running here.
    await startSeededExperiment(bindings.d1);
    const repo = createRepository(bindings.d1);
    await repo.identity.createAppMembership(appScope(ids.appId), {
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

export function harness(
  analysisResults: AnalysisResultsReader,
  authResolver: AuthResolver,
  repo: Repository = createRepository(bindings.d1),
) {
  return createApp({ authResolver, rateLimiter: allowLimiter, repo, analysisResults });
}

/**
 * Observes the two D1 reads the Environment budget governs: the planning read,
 * which must not run once a budget refuses, and the Environment read itself,
 * which must be bounded rather than materializing the whole App.
 */
export function spyOnPlanningReads(repo: Repository): {
  spied: Repository;
  listRunningExperiments: Mock<Repository["experiments"]["listRunningExperiments"]>;
  listEnvironments: Mock<Repository["identity"]["listEnvironments"]>;
} {
  const listRunningExperiments = vi.fn(
    repo.experiments.listRunningExperiments.bind(repo.experiments),
  );
  const listEnvironments = vi.fn(repo.identity.listEnvironments.bind(repo.identity));
  const spied: Repository = {
    ...repo,
    identity: { ...repo.identity, listEnvironments },
    experiments: { ...repo.experiments, listRunningExperiments },
  };
  return { spied, listRunningExperiments, listEnvironments };
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
