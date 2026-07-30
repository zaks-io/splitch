import { describe, expect, it, vi } from "vitest";
import {
  createPanelExperimentsClient,
  parseScopedAnalysisIdentity,
  SCOPED_SERVICE_IDENTITY_HEADER,
  scopedAnalysisResultsRequest,
} from "./panel-experiments";

describe("panel experiments binding transport", () => {
  it("parses the typed composite response", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        items: [
          {
            id: "exp_1",
            name: "Checkout",
            status: "running",
            flag: { id: "flag_1", name: "Checkout Flag" },
            liveRunId: "run_1",
            health: {
              significanceReached: true,
              srmFiring: false,
              guardrailBreached: false,
            },
          },
        ],
      }),
    );

    const result = await createPanelExperimentsClient({ fetch: fetcher }).list({
      appId: "app_1",
      environmentId: "env_1",
    });

    expect(result).toMatchObject({ ok: true, data: { items: [{ liveRunId: "run_1" }] } });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/control-panel/experiments/list",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("parses one Experiment with its ordered frozen Run snapshots", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        experiment: {
          id: "exp_1",
          name: "Checkout",
          description: "",
          owner: "",
          tags: [],
          status: "running",
          flagId: "flag_1",
          targetingKey: "userId",
          targetingKeyType: "user",
          activationMetricId: null,
          conversionWindowMs: 0,
          metricIds: [],
          guardrailMetricIds: [],
          draftAllocation: null,
          draftSalt: null,
          draftTargetingRulesJson: null,
          liveRunId: "run_2",
        },
        flag: { id: "flag_1", name: "Checkout Flag" },
        metrics: [],
        variants: [
          { id: "variant_control", name: "control" },
          { id: "variant_treatment", name: "treatment" },
        ],
        runs: [panelRun()],
      }),
    );

    const result = await createPanelExperimentsClient({ fetch: fetcher }).detail({
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { experiment: { id: "exp_1" }, runs: [{ runNumber: 2 }] },
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/control-panel/experiments/detail",
    );
  });

  it("binds the downstream identity to the exact operation, resources, and Run", async () => {
    const identity = {
      operation: "experiment_results_post" as const,
      actorId: "user_1",
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
      runId: "run_7",
    };
    const request = scopedAnalysisResultsRequest(identity);

    expect(
      parseScopedAnalysisIdentity(request.headers.get(SCOPED_SERVICE_IDENTITY_HEADER)),
    ).toEqual(identity);
    expect(await request.json()).toEqual({ runId: "run_7" });
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-splitch-panel-session")).toBeNull();
  });
});

function panelRun() {
  return {
    id: "run_2",
    experimentId: "exp_1",
    environmentId: "env_1",
    runNumber: 2,
    status: "running",
    targetingKey: "userId",
    targetingKeyType: "user",
    activationMetricId: null,
    salt: "salt-2",
    allocation: { control: 70, treatment: 30 },
    controlVariantId: "variant_control",
    variantsJson: JSON.stringify([
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ]),
    targetingRulesJson: "[]",
    decisionMetricIds: [],
    decisionGuardrailMetricIds: [],
    configHash: "sha256:two",
    startedAt: "2026-07-19T00:00:00.000Z",
    endedAt: null,
    startReason: "Increase treatment traffic",
    endReason: null,
    createdAt: "2026-07-19T00:00:00.000Z",
  };
}
