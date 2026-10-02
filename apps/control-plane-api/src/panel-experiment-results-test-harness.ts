import type { AnalysisResultsEnvelope, StatsOutput } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { vi } from "vitest";
import { panelExperimentResults } from "./panel-experiments";
import { analysisEnvelope, experimentRow, runRow } from "./panel-experiments-test-fixtures";

/** Shared by the Panel Results suites so each stays one concern per file. */
const APP_ID = "app_panel_results";
const ENVIRONMENT_ID = "env_panel_results";
export const ACTOR_ID = "user_panel_results";
const EXPERIMENT_ID = "exp_panel_results";
export const LATEST_RUN_ID = "run_panel_results_2";
export const PREVIOUS_RUN_ID = "run_panel_results_1";

export const ids = {
  appId: APP_ID,
  environmentId: ENVIRONMENT_ID,
  experimentId: EXPERIMENT_ID,
  latestRunId: LATEST_RUN_ID,
  previousRunId: PREVIOUS_RUN_ID,
  actorId: ACTOR_ID,
  flagId: "flag_panel_results",
  orgId: "org_panel_results",
};

export function repository(
  overrides: Record<string, unknown> & { runs?: Array<{ id: string; runNumber: number }> } = {},
): Repository {
  const {
    orgMembership = { role: "owner" },
    appMembership = { role: "owner" },
    environment = { id: ENVIRONMENT_ID },
    runs = [runRow(ids, 1), runRow(ids, 2)],
    experiment = experimentRow(ids),
  } = overrides;
  return {
    identity: {
      getApp: vi.fn(async () => ({ id: APP_ID, organizationId: ids.orgId })),
      getOrgMembershipForApp: vi.fn(async () => orgMembership),
      getAppMembership: vi.fn(async () => appMembership),
      getEnvironment: vi.fn(async () => environment),
    },
    flags: { flags: { findMany: vi.fn(async () => [{ id: ids.flagId, name: "Checkout Flag" }]) } },
    experiments: {
      getExperiment: vi.fn(async () => experiment),
      listRunsForExperiment: vi.fn(async () => runs),
      findLatestRunForExperiment: vi.fn(
        async () => [...runs].sort((left, right) => right.runNumber - left.runNumber)[0] ?? null,
      ),
      getRun: vi.fn(async (_scope, runId) => runs.find((run) => run.id === runId) ?? null),
    },
  } as unknown as Repository;
}

/** Echoes back the Run it was asked for, as the real Analysis Worker does. */
export function analysisReturning(
  stats: StatsOutput,
  envelope: Partial<Extract<AnalysisResultsEnvelope, { state: "ready" }>> = {},
) {
  return vi.fn(async (request: Request) => {
    const { runId } = (await request.clone().json()) as { runId: string };
    return Response.json(analysisEnvelope(runId, stats, envelope));
  });
}

export async function results(
  analysis: ReturnType<typeof analysisReturning>,
  input: { runId?: string } = {},
  repo: Repository = repository(),
) {
  return panelExperimentResults(
    { repo, analysis: { fetch: analysis } as unknown as Fetcher },
    {
      actorId: ACTOR_ID,
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      experimentId: EXPERIMENT_ID,
      ...input,
    },
  );
}
