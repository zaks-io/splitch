import { describe, expect, it } from "vitest";
import {
  AppAttentionRollupResponseSchema,
  EnvironmentAttentionRollupSchema,
  getRoute,
} from "./index";

describe("App attention rollup contract", () => {
  it("keeps Environment identity and no-data/clear/attention states explicit", () => {
    const response = AppAttentionRollupResponseSchema.parse({
      appId: "app_checkout",
      items: [
        { environmentId: "env_dev", state: "clear", srm: false, guardrail: false },
        { environmentId: "env_prod", state: "attention", srm: true, guardrail: true },
        { environmentId: "env_qa", state: "no_data", srm: false, guardrail: false },
      ],
    });

    expect(response.items.map((item) => item.environmentId)).toEqual([
      "env_dev",
      "env_prod",
      "env_qa",
    ]);
  });

  it("rejects fabricated failure flags outside the attention state", () => {
    expect(
      EnvironmentAttentionRollupSchema.safeParse({
        environmentId: "env_prod",
        state: "no_data",
        srm: true,
        guardrail: false,
      }).success,
    ).toBe(false);
    expect(
      EnvironmentAttentionRollupSchema.safeParse({
        environmentId: "env_prod",
        state: "attention",
        srm: false,
        guardrail: false,
      }).success,
    ).toBe(false);
  });

  it("registers the authenticated read-only Control Plane route", () => {
    expect(getRoute("app_attention_rollup_get")).toMatchObject({
      owner: "control-plane-api",
      method: "GET",
      path: "/apps/:appId/attention-rollup",
      auth: "control-plane-token",
      idempotency: "none",
    });
  });
});
