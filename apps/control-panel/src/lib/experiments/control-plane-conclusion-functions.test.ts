import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  experiments: vi.fn(),
  flags: vi.fn(),
  approvals: vi.fn(),
  conclude: vi.fn(),
  getConfig: vi.fn(),
  getFlag: vi.fn(),
  listSegments: vi.fn(),
  getApproval: vi.fn(),
  replacement: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator: (validate: (input: unknown) => unknown) => ({
      handler:
        (handler: (input: { data: unknown }) => Promise<unknown>) =>
        ({ data }: { data: unknown }) =>
          handler({ data: validate(data) }),
    }),
  }),
}));
vi.mock("#lib/auth/panel-authorized-clients", () => ({
  authorizedExperimentsClient: mocks.experiments,
  authorizedFlagDetailClients: mocks.flags,
  authorizedApprovalsClient: mocks.approvals,
}));

const {
  concludeControlPanelRun,
  loadControlPanelConclusionTarget,
  loadControlPanelConclusionApproval,
  replaceControlPanelConclusionPromotion,
} = await import("./control-plane-conclusion-functions");
const request = {
  appId: "app_1",
  environmentId: "env_1",
  experimentId: "experiment_1",
  runId: "run_1",
  selectedVariant: "treatment",
  expectedResultToken: `sha256:${"a".repeat(64)}`,
  dataWatermark: "2026-09-08T00:00:00.000Z",
  idempotencyKey: "conclude-1",
  target: {
    environmentId: "env_2",
    flagId: "flag_1",
    expectedConfigVersion: 4,
    proposedConfig: {
      enabled: true,
      availableVariantNames: ["treatment"],
      targetingRules: [],
      rollout: null,
    },
  },
};
const unauthorized = {
  ok: false as const,
  status: 401,
  error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.experiments.mockResolvedValue({
    ok: true,
    client: { conclude: mocks.conclude, createConclusionPromotionRequest: mocks.replacement },
  });
  mocks.flags.mockResolvedValue({
    ok: true,
    client: {
      flags: { get: mocks.getFlag, getConfig: mocks.getConfig },
      segments: { list: mocks.listSegments },
    },
  });
  mocks.listSegments.mockResolvedValue({
    ok: true,
    status: 200,
    data: { items: [], unparseable: [], readTruncated: false },
  });
  mocks.approvals.mockResolvedValue({ ok: true, client: { get: mocks.getApproval } });
});

describe("Panel conclusion boundary", () => {
  it("rejects partial configuration before calling a client", async () => {
    const result = await concludeControlPanelRun({
      data: { ...request, target: { ...request.target, proposedConfig: { enabled: true } } },
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mocks.conclude).not.toHaveBeenCalled();
  });

  it("requires a session for conclusion and target reads", async () => {
    mocks.experiments.mockResolvedValue({ ok: false, result: unauthorized });
    mocks.flags.mockResolvedValue({ ok: false, result: unauthorized });
    expect(await concludeControlPanelRun({ data: request })).toEqual(unauthorized);
    expect(
      await loadControlPanelConclusionTarget({
        data: { appId: "app_1", environmentId: "env_2", flagId: "flag_1" },
      }),
    ).toEqual(unauthorized);
    expect(mocks.conclude).not.toHaveBeenCalled();
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it("forwards the exact authored configuration and preserves a structured refusal", async () => {
    const failure = {
      ok: false,
      status: 409,
      error: {
        code: "DECISION_RESULT_STALE",
        message: "Results changed",
        details: { runId: "run_1" },
      },
    };
    mocks.conclude.mockResolvedValue(failure);
    expect(await concludeControlPanelRun({ data: request })).toEqual(failure);
    expect(mocks.conclude).toHaveBeenCalledWith(request);
  });

  it("uses the target's observed version, fields, and full rules", async () => {
    const rules = [
      {
        id: "rule_1",
        flagId: "flag_1",
        priority: 1,
        variantId: "variant_1",
        conditions: [{ attribute: "country", operator: "eq", value: "US" }],
        percentageRollout: { percentage: 20 },
      },
    ];
    mocks.getConfig.mockResolvedValue({
      ok: true,
      data: {
        version: 11,
        enabled: false,
        availableVariantNames: ["control"],
        targetingRules: [{ ...rules[0], percentageRollout: { percentage: 20, salt: "rule-salt" } }],
        rollout: { percentage: 30, salt: "server-salt" },
      },
    });
    mocks.getFlag.mockResolvedValue({
      ok: true,
      data: { variants: [{ id: "variant_1", name: "control" }] },
    });
    const result = await loadControlPanelConclusionTarget({
      data: { appId: "app_1", environmentId: "env_2", flagId: "flag_1" },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        version: 11,
        enabled: false,
        availableVariantNames: ["control"],
        targetingRulesJson: JSON.stringify(rules, null, 2),
        rolloutPercentage: 30,
      },
    });
    expect(mocks.flags).toHaveBeenCalledWith("env_2");
    expect(mocks.getFlag).toHaveBeenCalledWith({ appId: "app_1", flagId: "flag_1", by: "id" });
  });

  it("keeps conclusion evidence addressable when loading a pending approval", async () => {
    mocks.getApproval.mockResolvedValue({ ok: true, status: 200, data: approvalRequest() });
    expect(
      await loadControlPanelConclusionApproval({
        data: { appId: "app_1", approvalRequestId: "approval_1", variantLabels: {} },
      }),
    ).toMatchObject({
      ok: true,
      data: { conclusionId: "conclusion_1", request: { id: "approval_1", status: "pending" } },
    });
  });

  it("replaces a stale request without sending a new winner or configuration", async () => {
    const input = {
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "experiment_1",
      runId: "run_1",
      conclusionId: "conclusion_1",
      expectedConfigVersion: 12,
      idempotencyKey: "replacement-1",
    };
    mocks.replacement.mockResolvedValue({
      ok: true,
      status: 201,
      data: { conclusion: { id: "conclusion_1" }, approvalRequest: approvalRequest() },
    });
    expect(await replaceControlPanelConclusionPromotion({ data: input })).toMatchObject({
      ok: true,
    });
    expect(mocks.replacement).toHaveBeenCalledWith(input);
  });
});

function approvalRequest() {
  return {
    id: "approval_1",
    status: "pending",
    operation: "experiment_winner_promote",
    target: { type: "flag_configuration" },
    proposer: { userId: "user_1" },
    proposedAt: "2026-09-08T00:00:00.000Z",
    policyContexts: [],
    diff: { entries: [], current: { decision: { conclusionId: "conclusion_1" } }, proposed: {} },
  };
}
