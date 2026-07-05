import { describe, expect, it } from "vitest";
import { createControlPlaneSdk } from "./index";

const flagPage = {
  items: [
    {
      id: "flag_checkout",
      appId: "app_local",
      key: "checkout",
      name: "Checkout",
      variants: [{ id: "var_on", name: "on", value: true }],
      defaultVariantId: "var_on",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  ],
};

describe("control plane sdk typed route groups", () => {
  it("returns the parsed flags.list output instead of raw upstream JSON", async () => {
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async () =>
        Response.json({
          ...flagPage,
          unexpectedSecretLikeField: "must-not-escape",
        }),
    });

    const result = await sdk.flags.list({ appId: "app_local" });

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: flagPage,
    });
  });

  it("returns parsed experiments.list output", async () => {
    const experimentPage = {
      items: [
        {
          id: "exp_checkout",
          appId: "app_local",
          environmentId: "env_local",
          key: "checkout-exp",
          flagId: "flag_checkout",
          name: "Checkout experiment",
          status: "draft",
          targetingKey: "user_id",
          targetingKeyType: "string",
          confidenceLevel: 0.95,
          defaultVariantId: "var_on",
          metrics: [],
          guardrailMetrics: [],
          conversionWindowMs: 0,
          dimensions: [],
          liveRunId: null,
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    };

    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async () => Response.json(experimentPage),
    });

    const result = await sdk.experiments.list({
      appId: "app_local",
      environmentId: "env_local",
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: experimentPage,
    });
  });
});
