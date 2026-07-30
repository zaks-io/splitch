import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const flag = {
  id: "flag_checkout",
  appId: "app_checkout",
  key: "new-checkout",
  name: "New checkout",
  schema: null,
  variants: [
    { id: "var_off", name: "off", value: false },
    { id: "var_on", name: "on", value: true },
  ],
  defaultVariantId: "var_off",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const config = {
  flagId: "flag_checkout",
  environmentId: "env_prod",
  version: 3,
  enabled: true,
  availableVariantNames: ["off", "on"],
  targetingRules: [],
  rollout: null,
  experiment: null,
};

function sdkWith(response: () => Response) {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input as RequestInfo, init));
    return response();
  });
  return {
    sdk: createControlPlaneSdk({ baseUrl: "https://control-plane.test", fetch: fetcher }),
    requests,
  };
}

describe("control plane sdk Variant catalog operations", () => {
  it("sends the full create body, since the envelope itself requires appId and flagId", async () => {
    const { sdk, requests } = sdkWith(() => Response.json(flag));

    const result = await sdk.flags.createVariant({
      appId: "app_checkout",
      flagId: "flag_checkout",
      name: "on",
      value: true,
      idempotency_key: "variant-create-1",
    });

    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/flags/flag_checkout/variants",
    );
    await expect(requests[0]?.json()).resolves.toEqual({
      appId: "app_checkout",
      flagId: "flag_checkout",
      name: "on",
      value: true,
      idempotency_key: "variant-create-1",
    });
    expect(result).toEqual({ ok: true, status: 200, data: flag });
  });

  it("patches a Variant by name and returns the Approval envelope", async () => {
    const response = { flag, approvalRequest: null };
    const { sdk, requests } = sdkWith(() => Response.json(response));

    const result = await sdk.flags.updateVariant({
      appId: "app_checkout",
      flagId: "flag_checkout",
      variantName: "on",
      description: "the new checkout",
      idempotency_key: "variant-update-1",
    });

    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/flags/flag_checkout/variants/on",
    );
    expect(requests[0]?.method).toBe("PATCH");
    await expect(requests[0]?.json()).resolves.toEqual({
      description: "the new checkout",
      idempotency_key: "variant-update-1",
    });
    expect(result.ok && result.data.flag.variants).toHaveLength(2);
    expect(result.ok && result.data.approvalRequest).toBeNull();
  });

  it("deletes a Variant by name", async () => {
    const { sdk, requests } = sdkWith(() => Response.json(flag));

    await sdk.flags.deleteVariant({
      appId: "app_checkout",
      flagId: "flag_checkout",
      variantName: "on",
    });

    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/flags/flag_checkout/variants/on",
    );
  });

  it("surfaces the Worker's Run-frozen refusal on a Variant value change", async () => {
    const runFrozen = {
      code: "RUN_FROZEN",
      message: "A running Run includes this Variant",
      details: {
        frozenFields: ["value"],
        currentRunId: "run_live",
        attemptedChange: "variant.value",
        recommendedAction: "CREATE_NEW_RUN",
      },
    };
    const { sdk } = sdkWith(() => Response.json(runFrozen, { status: 409 }));

    await expect(
      sdk.flags.updateVariant({
        appId: "app_checkout",
        flagId: "flag_checkout",
        variantName: "on",
        value: false,
        idempotency_key: "variant-update-2",
      }),
    ).resolves.toEqual({ ok: false, status: 409, error: runFrozen });
  });
});

describe("control plane sdk targeting and promotion", () => {
  it("replaces the targeting rules for one Environment's Flag Configuration", async () => {
    const response = { config, approvalRequest: null };
    const { sdk, requests } = sdkWith(() => Response.json(response));

    const result = await sdk.flags.replaceTargetingRules({
      appId: "app_checkout",
      environmentId: "env_prod",
      flagId: "flag_checkout",
      targetingRules: [],
      idempotency_key: "targeting-replace-1",
    });

    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/envs/env_prod/flags/flag_checkout/targeting-rules",
    );
    await expect(requests[0]?.json()).resolves.toEqual({
      targetingRules: [],
      idempotency_key: "targeting-replace-1",
    });
    expect(result).toEqual({ ok: true, status: 200, data: response });
  });

  it("promotes selected field groups and returns the before/after diff", async () => {
    const { sdk, requests } = sdkWith(() =>
      Response.json({
        config,
        diff: { before: { ...config, enabled: false }, after: config },
        approvalRequest: null,
      }),
    );

    const result = await sdk.flags.promote({
      appId: "app_checkout",
      targetEnvironmentId: "env_prod",
      flagId: "flag_checkout",
      fromEnvironmentId: "env_dev",
      select: { enabled: true },
      review: { action: "approve_and_apply" },
      idempotency_key: "promote-1",
    });

    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/envs/env_prod/flags/flag_checkout/promote",
    );
    await expect(requests[0]?.json()).resolves.toEqual({
      fromEnvironmentId: "env_dev",
      select: { enabled: true },
      review: { action: "approve_and_apply" },
      idempotency_key: "promote-1",
    });
    expect(result.ok && result.data.diff.before.enabled).toBe(false);
    expect(result.ok && result.data.diff.after.enabled).toBe(true);
  });

  it("surfaces the durable Approval Request when Review is required", async () => {
    const approvalRequired = {
      code: "APPROVAL_REVIEW_REQUIRED",
      message: "Environment Policy requires Review for enabledState",
      details: {
        approvalRequestId: "apr_01J00000000000000000000000",
        status: "pending",
        policyContexts: [
          {
            environmentId: "env_prod",
            changeTypes: ["enabled_state"],
            level: "confirm",
          },
        ],
        recommendedAction: "REVIEW_APPROVAL_REQUEST",
      },
    };
    const { sdk } = sdkWith(() => Response.json(approvalRequired, { status: 409 }));

    await expect(
      sdk.flags.promote({
        appId: "app_checkout",
        targetEnvironmentId: "env_prod",
        flagId: "flag_checkout",
        fromEnvironmentId: "env_dev",
        select: { enabled: true },
        idempotency_key: "promote-2",
      }),
    ).resolves.toEqual({ ok: false, status: 409, error: approvalRequired });
  });
});
