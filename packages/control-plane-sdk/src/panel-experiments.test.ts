import { describe, expect, it, vi } from "vitest";
import { createPanelExperimentsClient } from "./panel-experiments";

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
            hasRuns: true,
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
          confidenceLevel: 0.95,
          dimensions: [],
          metricIds: [],
          guardrailMetricIds: [],
          draftAllocation: null,
          draftSalt: null,
          draftTargetingRulesJson: null,
          draftSegmentIds: ["segment_paid"],
          liveRunId: "run_2",
        },
        flag: { id: "flag_1", key: "checkout-flag", name: "Checkout Flag" },
        metrics: [],
        eventDefinitions: [],
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
      data: {
        // A Run freezes resolved Targeting Rules, never the Segment references
        // behind them, so dropping this here would make staged references
        // unreadable everywhere in the Panel.
        experiment: { id: "exp_1", draftSegmentIds: ["segment_paid"] },
        runs: [{ runNumber: 2 }],
      },
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/control-panel/experiments/detail",
    );
  });

  /**
   * The body → header mirror is applied per call site, so each call site needs
   * its own assertion: a single test on the shared helper stays green while any
   * one leg quietly stops passing the decorated options through. These drive the
   * PANEL client, whose mutations delegate to `createExperimentsClient` — a path
   * `idempotency-header.contract.test.ts` does not walk, and `experiments_create`
   * declares "optional" so the contract test's required-route sweep never reaches
   * it at all.
   */
  it("sends the Start idempotency key as the header the route requires", async () => {
    const request = await capturedRequest((client) =>
      client.start({
        appId: "app_1",
        environmentId: "env_1",
        experimentId: "exp_1",
        idempotency_key: "start-run-1",
        review: { action: "approve_and_apply" },
      } as never),
    );

    expect(request.headers.get("idempotency-key")).toBe("start-run-1");
  });

  it("sends the create idempotency key as a header, not body-only", async () => {
    const request = await capturedRequest((client) =>
      client.create({
        appId: "app_1",
        environmentId: "env_1",
        key: "checkout-copy",
        name: "Checkout copy",
        flagId: "flag_1",
        idempotency_key: "create-exp-1",
      } as never),
    );

    expect(request.headers.get("idempotency-key")).toBe("create-exp-1");
  });
});

async function capturedRequest(
  call: (client: ReturnType<typeof createPanelExperimentsClient>) => Promise<unknown>,
): Promise<Request> {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ code: "EXPERIMENT_NOT_FOUND", message: "gone", details: {} });
  });

  await call(createPanelExperimentsClient({ fetch: fetcher }));
  const request = requests[0];
  if (!request) throw new Error("the client made no request");
  return request;
}

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
    targetN: null,
    decisionFamilyJson: "[]",
    guardrailDecisionsJson: "[]",
    metricVarianceConfigJson: "[]",
    decisionMetricIds: [],
    decisionGuardrailMetricIds: [],
    confidenceLevel: 0.95,
    horizon: "sequential" as const,
    sampleSizeLocked: null,
    configHash: "sha256:two",
    startedAt: "2026-07-19T00:00:00.000Z",
    endedAt: null,
    startReason: "Increase treatment traffic",
    endReason: null,
    createdAt: "2026-07-19T00:00:00.000Z",
  };
}
