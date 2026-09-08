import { canonicalHash } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { concludeRun } from "./experiment-conclusion-handler";
import {
  APP_ID,
  conclusionFixture,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  RUN_ID,
  readyEnvelope,
  resultToken,
  runRow,
  WATERMARK,
} from "./experiment-conclusion-handler-test-fixtures";
import { approvalRow, conclusionRow } from "./experiment-conclusion-replay-test-fixtures";
import { statsOutput } from "./panel-experiments-test-fixtures";

describe("concludeRun refusals", () => {
  it("requires a live owner or admin membership before disclosing Run or target state", async () => {
    const fixture = conclusionFixture({ membershipRole: "member" });

    const response = await concludeRun(fixture.deps, fixture.args);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.readRun).not.toHaveBeenCalled();
    expect(fixture.readTargetConfig).not.toHaveBeenCalled();
    expect(fixture.analysis).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("refuses a stale target before Analysis and writes nothing", async () => {
    const fixture = conclusionFixture({ targetConfigVersion: 2 });

    const response = await concludeRun(fixture.deps, fixture.args);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "TARGET_CONFIGURATION_STALE",
      details: { expectedConfigVersion: 1, currentConfigVersion: 2 },
    });
    expect(fixture.analysis).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("fails loud when Analysis changes the submitted watermark and writes nothing", async () => {
    const fixture = conclusionFixture({
      analysisEnvelope: {
        state: "ready",
        run_id: RUN_ID,
        control_variant: "control",
        data_watermark: "2026-09-08T18:01:00.000Z",
        result_token: `sha256:${"a".repeat(64)}`,
        stats: statsOutput(),
      },
    });

    await expect(concludeRun(fixture.deps, fixture.args)).rejects.toThrow(
      "Analysis changed the submitted conclusion watermark",
    );
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("fails loud when Analysis answers for a different Run and writes nothing", async () => {
    const fixture = conclusionFixture({
      analysisEnvelope: {
        state: "ready",
        run_id: "run_other",
        control_variant: "control",
        data_watermark: WATERMARK,
        result_token: `sha256:${"a".repeat(64)}`,
        stats: statsOutput(),
      },
    });

    await expect(concludeRun(fixture.deps, fixture.args)).rejects.toThrow(
      "Analysis answered for Run run_other, not run_conclusion",
    );
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("fails loud when the result token is not bound to the Run Configuration", async () => {
    const fixture = conclusionFixture({
      analysisEnvelope: {
        state: "ready",
        run_id: RUN_ID,
        control_variant: "control",
        data_watermark: WATERMARK,
        result_token: `sha256:${"a".repeat(64)}`,
        stats: statsOutput(),
      },
    });

    await expect(concludeRun(fixture.deps, fixture.args)).rejects.toThrow(
      "Analysis result token is not bound to the selected Run configuration",
    );
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("returns unavailable for an unmeasured result and writes nothing", async () => {
    const fixture = conclusionFixture({
      analysisEnvelope: {
        state: "no_data",
        run_id: RUN_ID,
        control_variant: "control",
        missing: "exposures",
      },
    });

    const response = await concludeRun(fixture.deps, fixture.args);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "DECISION_RESULT_UNAVAILABLE",
      details: { runId: RUN_ID, envelopeState: "no_data" },
    });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("returns stale for a changed bound result and writes nothing", async () => {
    const currentStats = statsOutput();
    const currentToken = await resultToken(currentStats);
    const fixture = conclusionFixture({
      expectedResultToken: `sha256:${"f".repeat(64)}`,
      analysisEnvelope: readyEnvelope(currentStats, currentToken),
    });

    const response = await concludeRun(fixture.deps, fixture.args);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "DECISION_RESULT_STALE",
      details: {
        runId: RUN_ID,
        expectedResultToken: `sha256:${"f".repeat(64)}`,
        currentResultToken: currentToken,
      },
    });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("returns every failed decision title and writes nothing", async () => {
    const blockedStats = statsOutput({
      srm: {
        ...statsOutput().srm,
        srm_p_value: 0.0001,
        srm_is_mismatch: true,
      },
      health: { ...statsOutput().health, low_n_warning: true },
    });
    const token = await resultToken(blockedStats);
    const fixture = conclusionFixture({
      expectedResultToken: token,
      analysisEnvelope: readyEnvelope(blockedStats, token),
    });

    const response = await concludeRun(fixture.deps, fixture.args);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "DECISION_BLOCKED",
      message: "Run conclusion is blocked: Sample Ratio Mismatch is firing; Result is underpowered",
      details: {
        failures: [{ code: "DECISION_UNDERPOWERED" }, { code: "DECISION_SRM_MISMATCH" }],
      },
    });
    expect(fixture.commit).not.toHaveBeenCalled();
  });
});

describe("concludeRun Approval target identity", () => {
  it("binds the Approval target version to the Flag Configuration row id", async () => {
    const stats = statsOutput();
    const token = await resultToken(stats);
    const fixture = conclusionFixture({
      expectedResultToken: token,
      analysisEnvelope: readyEnvelope(stats, token),
    });
    fixture.commit.mockRejectedValue(new Error("stop after capturing the atomic input"));

    await expect(concludeRun(fixture.deps, fixture.args)).rejects.toThrow(
      "stop after capturing the atomic input",
    );

    const atomicInput = fixture.commit.mock.calls[0]?.[1];
    expect(atomicInput?.approval.targetId).toBe("flag_config_conclusion");
    expect(JSON.parse(atomicInput?.approval.policyContexts ?? "null")).toEqual([
      { environmentId: ENVIRONMENT_ID, changeTypes: ["enabled_state"], level: "confirm" },
    ]);
    expect(JSON.parse(atomicInput?.approval.policyGuardContexts ?? "null")).toEqual([
      { environmentId: ENVIRONMENT_ID, changeTypes: ["enabled_state"], level: "allow" },
    ]);
    expect(atomicInput?.approval.targetVersion).toBe(
      await canonicalHash({
        flagConfigVersion: 1,
        policy: [
          {
            environmentId: ENVIRONMENT_ID,
            changeType: "enabled_state",
            level: "allow",
          },
        ],
      }),
    );
  });
});

describe("concludeRun replay", () => {
  it("returns an exact replay without contacting Analysis", async () => {
    const fixture = conclusionFixture();
    const requestHash = await canonicalHash({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      experimentId: EXPERIMENT_ID,
      runId: RUN_ID,
      ...fixture.body,
    });
    const conclusion = conclusionRow(requestHash);
    vi.mocked(fixture.repo.experimentConclusions.getByActorKey).mockResolvedValue(conclusion);
    vi.mocked(fixture.repo.experimentConclusions.listApprovalLinks).mockResolvedValue([
      {
        appId: APP_ID,
        conclusionId: conclusion.id,
        approvalRequestId: "apr_01J00000000000000000000000",
        ordinal: 1,
        createdAt: "2026-09-08T18:02:00.000Z",
      },
    ]);
    vi.mocked(fixture.repo.experimentConclusions.get).mockResolvedValue(conclusion);
    vi.mocked(fixture.repo.experiments.getRun).mockResolvedValue(runRow("ended"));
    vi.mocked(fixture.repo.approvals.getRequest).mockResolvedValue(approvalRow());

    const response = await concludeRun({ ...fixture.deps, analysis: undefined }, fixture.args);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conclusion: { id: conclusion.id, runId: RUN_ID },
      approvalRequest: { id: "apr_01J00000000000000000000000" },
    });
    expect(fixture.analysis).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });
});
