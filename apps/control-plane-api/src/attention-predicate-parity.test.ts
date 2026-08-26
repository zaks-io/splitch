import type { StatsOutput } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { makeAttentionRollupHandler } from "./attention-rollup";
import { panelExperimentsList } from "./panel-experiments";
import {
  analysisEnvelope,
  experimentRow,
  type PanelExperimentIds,
  runRow,
  statsOutput as buildStatsOutput,
} from "./panel-experiments-test-fixtures";

const APP_ID = "app_parity";
const ENVIRONMENT_ID = "env_parity";
const ACTOR_ID = "user_parity";
const EXPERIMENT_ID = "exp_parity";
const RUN_ID = "run_parity";

const ids: PanelExperimentIds = {
  appId: APP_ID,
  environmentId: ENVIRONMENT_ID,
  experimentId: EXPERIMENT_ID,
  latestRunId: RUN_ID,
  previousRunId: "run_parity_previous",
  actorId: ACTOR_ID,
  flagId: "flag_parity",
  orgId: "org_parity",
};

/**
 * `srmFiring`/`guardrailBreached` (packages/control-plane-sdk/src/panel-experiments.ts)
 * are documented as the single source for "this Run needs attention" precisely
 * because the Experiment list and the Environment attention rollup are two
 * independent read paths over the same predicate. A merge once re-implemented
 * the predicate inline on the Experiment list, dropping the
 * `activated_srm_mismatch` clause, and every existing test stayed green because
 * none of them exercised that clause on both surfaces at once. This test drives
 * both production handlers from the exact same StatsOutput and fails if they
 * disagree about whether it needs attention.
 */
describe("Experiment list / attention rollup predicate parity", () => {
  it("agrees an activated-SRM mismatch alone needs attention, on both surfaces", async () => {
    const clean = buildStatsOutput();
    const stats: StatsOutput = {
      ...clean,
      srm: { ...clean.srm, srm_is_mismatch: false, activated_srm_mismatch: true },
      guardrail_results: clean.guardrail_results.map((result) => ({
        ...result,
        is_breached: false,
      })),
      health: { ...clean.health, activation_balance_mismatch: null },
    };

    // Surface 1: the Experiment list.
    const listAnalysis = vi.fn(async (_request: Request) =>
      Response.json(analysisEnvelope(RUN_ID, stats)),
    );
    const listResponse = await panelExperimentsList(
      { repo: panelExperimentsRepo(), analysis: { fetch: listAnalysis } as unknown as Fetcher },
      { actorId: ACTOR_ID, appId: APP_ID, environmentId: ENVIRONMENT_ID },
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      items: Array<{ id: string; health: { srmFiring: boolean; guardrailBreached: boolean } }>;
    };
    const listItem = listBody.items.find((item) => item.id === EXPERIMENT_ID);
    if (!listItem) throw new Error("Experiment list is missing the seeded Experiment");

    // Surface 2: the Environment attention rollup, reading the same Run.
    const rollupHandler = makeAttentionRollupHandler({
      repo: attentionRollupRepo(),
      analysisResults: {
        async read() {
          return stats;
        },
      },
    });
    const rollupResponse = await rollupHandler({
      input: { params: { appId: APP_ID } },
      principal: principalFor(ACTOR_ID),
      requestId: "req_parity",
      request: new Request(`https://control-plane.internal/apps/${APP_ID}/attention-rollup`),
    });
    expect(rollupResponse.status).toBe(200);
    const rollupBody = (await rollupResponse.json()) as {
      items: Array<{ environmentId: string; srm: boolean; guardrail: boolean }>;
    };
    const rollupItem = rollupBody.items.find((item) => item.environmentId === ENVIRONMENT_ID);
    if (!rollupItem) throw new Error("attention rollup is missing the seeded Environment");

    // The point of this test: both surfaces read the SAME activated-SRM-only
    // input as attention-worthy. Pin both to true (not to each other) so a
    // regression that flips BOTH surfaces the same wrong way still fails.
    expect(listItem.health.srmFiring).toBe(true);
    expect(listItem.health.guardrailBreached).toBe(false);
    expect(rollupItem.srm).toBe(true);
    expect(rollupItem.guardrail).toBe(false);
  });
});

function principalFor(id: string): Principal {
  return {
    kind: "control-plane-token",
    id,
    scopes: [`app:${APP_ID}:member`],
    orgId: null,
    appId: APP_ID,
    environmentId: null,
    authDoor: "id_jag",
  };
}

function panelExperimentsRepo(): Repository {
  return {
    identity: {
      getApp: vi.fn(async () => ({ id: APP_ID, organizationId: ids.orgId })),
      getOrgMembershipForApp: vi.fn(async () => ({ role: "member" })),
      getAppMembership: vi.fn(async () => ({ role: "member" })),
      getEnvironment: vi.fn(async () => ({ id: ENVIRONMENT_ID, appId: APP_ID })),
    },
    flags: {
      flags: { findMany: vi.fn(async () => [{ id: "flag_parity", name: "Checkout Flag" }]) },
    },
    experiments: {
      listExperiments: vi.fn(async () => [experimentRow(ids)]),
      getExperiment: vi.fn(async () => experimentRow(ids)),
      listRunsForExperiment: vi.fn(async () => [runRow(ids, 1), runRow(ids, 2)]),
    },
  } as unknown as Repository;
}

function attentionRollupRepo(): Repository {
  return {
    identity: {
      getApp: vi.fn(async () => ({ id: APP_ID, organizationId: ids.orgId })),
      getOrgMembership: vi.fn(async () => ({ role: "member" })),
      getAppMembership: vi.fn(async () => ({ role: "member" })),
      listEnvironments: vi.fn(async () => [{ id: ENVIRONMENT_ID }]),
    },
    experiments: {
      listRunningExperiments: vi.fn(async () => [{ id: EXPERIMENT_ID, liveRunId: RUN_ID }]),
      countRunningExperiments: vi.fn(async () => 1),
    },
  } as unknown as Repository;
}
