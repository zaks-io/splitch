import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { panelExperimentRouteResolution } from "./panel-experiment-route-resolution";
import { experimentRow, type PanelExperimentIds, runRow } from "./panel-experiments-test-fixtures";

const ids: PanelExperimentIds = {
  appId: "app_1",
  environmentId: "env_dev",
  experimentId: "exp_dev",
  latestRunId: "run_dev",
  previousRunId: "run_previous",
  actorId: "user_1",
  flagId: "flag_1",
  orgId: "org_1",
};

describe("panel Experiment route resolution", () => {
  it("keeps a canonical key distinct from another Experiment's matching ID", async () => {
    const keyOwner = { ...experimentRow(ids), id: "exp_key_owner", key: "exp_collision" };
    const idOwner = {
      ...experimentRow(ids),
      id: "exp_collision",
      key: "different-key",
      environmentId: "env_prod",
    };
    const repo = repository({
      referenced: [keyOwner, idOwner],
      candidates: [keyOwner],
      runs: [],
    });

    const response = await panelExperimentRouteResolution(
      { repo },
      {
        actorId: ids.actorId,
        appId: ids.appId,
        targetEnvironmentId: ids.environmentId,
        experimentRef: "exp_collision",
        referenceKind: "key",
      },
    );

    expect(await response.json()).toEqual({
      kind: "experiment",
      experimentId: "exp_key_owner",
      experimentKey: "exp_collision",
    });
    expect(repo.experiments.findExperimentsByReferenceAcrossEnvironments).not.toHaveBeenCalled();
  });

  it("canonicalizes a foreign legacy Experiment ID when the Run is local", async () => {
    const foreign = { ...experimentRow(ids), id: "exp_prod", environmentId: "env_prod" };
    const response = await resolve({
      experimentRef: foreign.id,
      runId: ids.latestRunId,
      referenced: [foreign],
      candidates: [foreign, experimentRow(ids)],
      runs: [runRow(ids, 2)],
    });

    expect(await response.json()).toEqual({
      kind: "experiment",
      experimentId: ids.experimentId,
      experimentKey: "checkout-test",
    });
  });

  it("returns the owning Environment for a foreign Run", async () => {
    const foreignIds = {
      ...ids,
      environmentId: "env_prod",
      experimentId: "exp_prod",
      latestRunId: "run_prod",
    };
    const response = await resolve({
      experimentRef: "checkout-test",
      runId: foreignIds.latestRunId,
      referenced: [experimentRow(ids)],
      candidates: [experimentRow(ids), experimentRow(foreignIds)],
      runs: [runRow(foreignIds, 2)],
    });

    expect(await response.json()).toEqual({
      kind: "run_elsewhere",
      env: "prod",
      experimentId: foreignIds.experimentId,
      experimentKey: "checkout-test",
      runId: foreignIds.latestRunId,
    });
  });

  it("returns explicit not-found outcomes for unknown Experiment and Run references", async () => {
    const missingExperiment = await resolve({
      experimentRef: "missing",
      referenced: [],
      candidates: [],
      runs: [],
    });
    const missingRun = await resolve({
      experimentRef: "checkout-test",
      runId: "missing",
      referenced: [experimentRow(ids)],
      candidates: [experimentRow(ids)],
      runs: [],
    });

    expect(await missingExperiment.json()).toEqual({ kind: "experiment_not_found" });
    expect(await missingRun.json()).toEqual({
      kind: "run_not_found",
      experimentKey: "checkout-test",
    });
  });
});

function resolve(input: {
  experimentRef: string;
  runId?: string;
  referenced: object[];
  candidates: object[];
  runs: object[];
}) {
  return panelExperimentRouteResolution(
    { repo: repository(input) },
    {
      actorId: ids.actorId,
      appId: ids.appId,
      targetEnvironmentId: ids.environmentId,
      experimentRef: input.experimentRef,
      referenceKind: "legacy",
      runId: input.runId,
    },
  );
}

function repository(input: {
  referenced: object[];
  candidates: object[];
  runs: object[];
}): Repository {
  return {
    identity: {
      getApp: vi.fn(async () => ({ id: ids.appId, organizationId: ids.orgId })),
      getOrgMembershipForApp: vi.fn(async () => ({ role: "member" })),
      getAppMembership: vi.fn(async () => ({ role: "member" })),
      getEnvironment: vi.fn(async () => ({ id: ids.environmentId, appId: ids.appId })),
      listEnvironments: vi.fn(async () => [
        { id: ids.environmentId, key: "dev" },
        { id: "env_prod", key: "prod" },
      ]),
    },
    experiments: {
      findExperimentsByReferenceAcrossEnvironments: vi.fn(async () => input.referenced),
      findExperimentsByKeyAcrossEnvironments: vi.fn(async () => input.candidates),
      findRunsByIdAcrossEnvironments: vi.fn(async () => input.runs),
    },
  } as unknown as Repository;
}
