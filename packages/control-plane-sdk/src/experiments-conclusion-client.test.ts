import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const APP = "app_checkout";
const ENV = "env_production";
const EXPERIMENT = "exp_checkout";
const RUN = "run_checkout_4";
const CONCLUSION = "conclusion_checkout_4";

describe("control plane SDK Experiment conclusion transport", () => {
  it("sends Conclude to the selected Run with one strict body and mirrored key", async () => {
    const request = await captureRequest((sdk) =>
      sdk.experiments.conclude({
        appId: APP,
        environmentId: ENV,
        experimentId: EXPERIMENT,
        runId: RUN,
        selectedVariant: "treatment",
        expectedResultToken: `sha256:${"a".repeat(64)}`,
        dataWatermark: "2026-09-08T12:00:00.000Z",
        target: {
          environmentId: "env_target",
          flagId: "flag_checkout",
          expectedConfigVersion: 7,
          proposedConfig: {
            enabled: true,
            availableVariantNames: ["control", "treatment"],
            targetingRules: [],
            rollout: { percentage: 100 },
          },
        },
        review: { action: "approve_and_apply" },
        reason: "Ship the measured winner",
        idempotencyKey: "conclude-checkout-run-4",
      }),
    );

    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      `https://control-plane.test/apps/${APP}/envs/${ENV}/experiments/${EXPERIMENT}/runs/${RUN}/conclusions`,
    );
    expect(request.headers.get("idempotency-key")).toBe("conclude-checkout-run-4");
    expect(await request.json()).toEqual({
      selectedVariant: "treatment",
      expectedResultToken: `sha256:${"a".repeat(64)}`,
      dataWatermark: "2026-09-08T12:00:00.000Z",
      target: {
        environmentId: "env_target",
        flagId: "flag_checkout",
        expectedConfigVersion: 7,
        proposedConfig: {
          enabled: true,
          availableVariantNames: ["control", "treatment"],
          targetingRules: [],
          rollout: { percentage: 100 },
        },
      },
      review: { action: "approve_and_apply" },
      reason: "Ship the measured winner",
      idempotencyKey: "conclude-checkout-run-4",
    });
  });

  it("creates a replacement Promotion request from the named conclusion", async () => {
    const request = await captureRequest((sdk) =>
      sdk.experiments.createConclusionPromotionRequest({
        appId: APP,
        environmentId: ENV,
        experimentId: EXPERIMENT,
        runId: RUN,
        conclusionId: CONCLUSION,
        expectedConfigVersion: 8,
        review: { action: "approve_and_apply" },
        idempotencyKey: "replace-checkout-promotion-1",
      }),
    );

    expect(request.url).toBe(
      `https://control-plane.test/apps/${APP}/envs/${ENV}/experiments/${EXPERIMENT}/runs/${RUN}/conclusions/${CONCLUSION}/promotion-requests`,
    );
    expect(request.headers.get("idempotency-key")).toBe("replace-checkout-promotion-1");
    expect(await request.json()).toEqual({
      expectedConfigVersion: 8,
      review: { action: "approve_and_apply" },
      idempotencyKey: "replace-checkout-promotion-1",
    });
  });
});

async function captureRequest(
  call: (sdk: ReturnType<typeof createControlPlaneSdk>) => Promise<unknown>,
): Promise<Request> {
  let captured: Request | undefined;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input, init);
    return Response.json({ code: "RUN_NOT_FOUND", message: "gone", details: {} }, { status: 404 });
  });

  await call(createControlPlaneSdk({ baseUrl: "https://control-plane.test", fetch: fetcher }));
  if (!captured) throw new Error("the SDK made no request");
  return captured;
}
