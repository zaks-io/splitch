import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  resolveConclusionGuardFailure,
  resolveReplacementGuardFailure,
} from "./experiment-conclusion-guard-errors";
import type { ExperimentDeps } from "./experiment-handler-shared";

const APP_ID = "app_guard";
const ENVIRONMENT_ID = "env_run";
const TARGET_ENVIRONMENT_ID = "env_target";
const EXPERIMENT_ID = "exp_guard";
const RUN_ID = "run_guard";
const FLAG_ID = "flag_guard";
const CONCLUSION_ID = "con_guard";
const IDEMPOTENCY_KEY = "guard-key";
const REQUEST_HASH = "sha256:request";

function fixture(
  options: {
    conclusionReplay?: { id: string; requestHash: string } | null;
    replacementReplay?: { id: string; requestHash: string } | null;
    replacementLinked?: boolean;
    membership?: { role: string } | null;
    run?: { status: string } | null;
    experiment?: { liveRunId: string | null } | null;
    targetVersion?: number;
  } = {},
) {
  const getConclusionReplay = vi.fn(async () => options.conclusionReplay ?? null);
  const getReplacementReplay = vi.fn(async () => options.replacementReplay ?? null);
  const getMembership = vi.fn(async () =>
    options.membership === undefined ? { role: "admin" } : options.membership,
  );
  const getRun = vi.fn(async () =>
    options.run === undefined ? { status: "running" } : options.run,
  );
  const getExperiment = vi.fn(async () =>
    options.experiment === undefined ? { liveRunId: RUN_ID } : options.experiment,
  );
  const getTarget = vi.fn(async () => ({ version: options.targetVersion ?? 1 }));
  const listApprovalLinks = vi.fn(async () =>
    options.replacementLinked === false || !options.replacementReplay
      ? []
      : [{ approvalRequestId: options.replacementReplay.id }],
  );
  const deps = {
    repo: {
      identity: { getAppMembership: getMembership },
      experiments: { getRun, getExperiment },
      flags: { getFlagConfig: getTarget },
      experimentConclusions: {
        getByActorKey: getConclusionReplay,
        listApprovalLinks,
      },
      approvals: { getRequestByActorKey: getReplacementReplay },
    },
  } as unknown as ExperimentDeps;
  return {
    deps,
    getConclusionReplay,
    getExperiment,
    getMembership,
    getReplacementReplay,
    getRun,
    getTarget,
    listApprovalLinks,
  };
}

const args = {
  principal: {
    kind: "control-plane-token",
    id: "user_guard",
    scopes: [`app:${APP_ID}:admin`],
    orgId: null,
    appId: APP_ID,
    environmentId: null,
    authDoor: "device_flow",
  } satisfies Principal,
  requestId: "request_guard",
  input: {},
  request: new Request("https://control.splitch.dev/test"),
} satisfies HandlerArgs<unknown>;

const conclusionInput = {
  appId: APP_ID,
  environmentId: ENVIRONMENT_ID,
  targetEnvironmentId: TARGET_ENVIRONMENT_ID,
  experimentId: EXPERIMENT_ID,
  runId: RUN_ID,
  flagId: FLAG_ID,
  expectedConfigVersion: 1,
  idempotencyKey: IDEMPOTENCY_KEY,
  requestHash: REQUEST_HASH,
};

const replacementInput = {
  appId: APP_ID,
  targetEnvironmentId: TARGET_ENVIRONMENT_ID,
  flagId: FLAG_ID,
  expectedConfigVersion: 1,
  conclusionId: CONCLUSION_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  requestHash: REQUEST_HASH,
};

describe("conclusion D1 guard failure resolution", () => {
  it("recovers an exact replay before reading guard state", async () => {
    const replay = { id: CONCLUSION_ID, requestHash: REQUEST_HASH };
    const state = fixture({ conclusionReplay: replay });

    await expect(
      resolveConclusionGuardFailure(state.deps, args, conclusionInput, new Error("D1 assertion")),
    ).resolves.toEqual({ kind: "replay", conclusion: replay });
    expect(state.getMembership).not.toHaveBeenCalled();
    expect(state.getRun).not.toHaveBeenCalled();
    expect(state.getTarget).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN for a membership revocation without disclosing later guard state", async () => {
    const state = fixture({ membership: null, run: { status: "ended" }, targetVersion: 2 });

    const result = await resolveConclusionGuardFailure(
      state.deps,
      args,
      conclusionInput,
      new Error("D1 assertion"),
    );

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      await expect(result.response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(state.getRun).not.toHaveBeenCalled();
    expect(state.getTarget).not.toHaveBeenCalled();
  });

  it("returns RUN_NOT_RUNNING when the Run ends before the atomic write", async () => {
    const state = fixture({ run: { status: "ended" }, targetVersion: 2 });

    const result = await resolveConclusionGuardFailure(
      state.deps,
      args,
      conclusionInput,
      new Error("D1 assertion"),
    );

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      await expect(result.response.json()).resolves.toMatchObject({ code: "RUN_NOT_RUNNING" });
    }
    expect(state.getTarget).not.toHaveBeenCalled();
  });

  it("returns TARGET_CONFIGURATION_STALE when the guarded target version changes", async () => {
    const state = fixture({ targetVersion: 2 });

    const result = await resolveConclusionGuardFailure(
      state.deps,
      args,
      conclusionInput,
      new Error("D1 assertion"),
    );

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      await expect(result.response.json()).resolves.toMatchObject({
        code: "TARGET_CONFIGURATION_STALE",
        details: { expectedConfigVersion: 1, currentConfigVersion: 2 },
      });
    }
  });

  it("rethrows an unrelated D1 error while every guard remains valid", async () => {
    const state = fixture();
    const cause = new Error("D1_ERROR: Network connection lost");

    await expect(
      resolveConclusionGuardFailure(state.deps, args, conclusionInput, cause),
    ).rejects.toBe(cause);
  });
});

describe("replacement D1 guard failure resolution", () => {
  it("recovers only an exact linked replay before reading guard state", async () => {
    const replay = { id: "apr_replay", requestHash: REQUEST_HASH };
    const state = fixture({ replacementReplay: replay });

    await expect(
      resolveReplacementGuardFailure(state.deps, args, replacementInput, new Error("D1 assertion")),
    ).resolves.toEqual({ kind: "replay", approval: replay });
    expect(state.listApprovalLinks).toHaveBeenCalledOnce();
    expect(state.getMembership).not.toHaveBeenCalled();
    expect(state.getTarget).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN before target state when membership was revoked", async () => {
    const state = fixture({ membership: null, targetVersion: 2 });

    const result = await resolveReplacementGuardFailure(
      state.deps,
      args,
      replacementInput,
      new Error("D1 assertion"),
    );

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      await expect(result.response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(state.getTarget).not.toHaveBeenCalled();
  });

  it("returns TARGET_CONFIGURATION_STALE for target drift", async () => {
    const state = fixture({ targetVersion: 2 });

    const result = await resolveReplacementGuardFailure(
      state.deps,
      args,
      replacementInput,
      new Error("D1 assertion"),
    );

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      await expect(result.response.json()).resolves.toMatchObject({
        code: "TARGET_CONFIGURATION_STALE",
        details: { expectedConfigVersion: 1, currentConfigVersion: 2 },
      });
    }
  });

  it("rethrows an unrelated D1 error while every guard remains valid", async () => {
    const state = fixture();
    const cause = new Error("D1_ERROR: Network connection lost");

    await expect(
      resolveReplacementGuardFailure(state.deps, args, replacementInput, cause),
    ).rejects.toBe(cause);
  });
});
