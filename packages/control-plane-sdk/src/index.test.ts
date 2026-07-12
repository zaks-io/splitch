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

  it("flags.create sends appId in the JSON body for Worker validation", async () => {
    let capturedBody: unknown;
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (_input, init) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return Response.json(flagPage.items[0]);
      },
    });

    await sdk.flags.create({
      appId: "app_local",
      name: "Checkout",
      key: "checkout",
      schema: null,
      variants: [{ name: "on", value: true, isDefault: true }],
    });

    expect(capturedBody).toMatchObject({ appId: "app_local", key: "checkout" });
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

  it("experiments.create sends appId and environmentId in the JSON body", async () => {
    let capturedBody: unknown;
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (_input, init) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return Response.json({
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
        });
      },
    });

    await sdk.experiments.create({
      appId: "app_local",
      environmentId: "env_local",
      name: "Checkout experiment",
      key: "checkout-exp",
      flagId: "flag_checkout",
      targetingKey: "user_id",
      targetingKeyType: "string",
      metrics: [{ metricId: "m_1" }],
      guardrailMetrics: [],
      confidenceLevel: 0.95,
      conversionWindowMs: 0,
      dimensions: [],
    });

    expect(capturedBody).toMatchObject({
      appId: "app_local",
      environmentId: "env_local",
      key: "checkout-exp",
    });
  });

  it("preserves a base URL path prefix for typed routes and health()", async () => {
    const urls: string[] = [];
    const sdk = createControlPlaneSdk({
      baseUrl: "https://gateway.test/control-plane",
      fetch: async (input) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return Response.json(flagPage);
      },
    });

    await sdk.flags.list({ appId: "app_local" });
    await sdk.health().catch(() => undefined);

    expect(urls[0]).toBe("https://gateway.test/control-plane/apps/app_local/flags");
    expect(urls[1]).toBe("https://gateway.test/control-plane/health");
  });
});
