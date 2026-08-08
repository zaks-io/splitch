import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { createMcpOperationAdapter } from "./mcp-operation-adapter";

const flag = {
  id: "flag_checkout",
  appId: "app_local",
  key: "checkout",
  name: "Checkout",
  variants: [{ id: "var_on", name: "on", value: true }],
  defaultVariantId: "var_on",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

const flagConfig = {
  flagId: "flag_checkout",
  environmentId: "env_local",
  version: 2,
  enabled: true,
  availableVariantNames: ["on"],
  targetingRules: [],
  rollout: null,
  experiment: null,
};

describe("mcp operation adapter body path stripping (SPL-296)", () => {
  it("strips path context from an invalid targeting-rules body", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json(
          {
            code: "VALIDATION_ERROR",
            message: "request failed schema validation",
            details: {
              issues: [
                {
                  path: ["body"],
                  message: 'Unrecognized keys: "rules"',
                },
              ],
            },
          },
          { status: 400 },
        );
      },
    });

    // Cold-agent schema probe: caller sent `rules` (wrong name). Context ids are
    // flat MCP/CLI input, not body fields — they must stay off the wire body so
    // VALIDATION_ERROR issues do not blame keys the caller cannot remove.
    const result = await adapter.callOperationById("flag_targeting_rules_replace", {
      appId: "app_local",
      environmentId: "env_local",
      flagId: "flag_checkout",
      rules: [],
      idempotency_key: "targeting-rules-probe",
    });

    expect(result.ok).toBe(false);
    expect(forwardedRequest?.url).toBe(
      "https://control-plane.test/apps/app_local/envs/env_local/flags/flag_checkout/targeting-rules",
    );
    const outboundBody = await forwardedRequest?.json();
    expect(outboundBody).toEqual({
      rules: [],
      idempotency_key: "targeting-rules-probe",
    });

    const bodySchema = routeBodySchema("flag_targeting_rules_replace");
    const issues = bodySchema.safeParse(outboundBody);
    expect(issues.success).toBe(false);
    if (issues.success) {
      throw new Error("expected ReplaceTargetingRulesRequestSchema to reject the outbound body");
    }
    const messages = issues.error.issues.map((issue) => issue.message).join("\n");
    expect(messages).toMatch(/Unrecognized key|Required|targetingRules/i);
    expect(messages).not.toMatch(/appId|environmentId|flagId/);
  });

  it("still strips path context on a valid targeting-rules replace", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json({ config: flagConfig, approvalRequest: null });
      },
    });

    const result = await adapter.callOperationById("flag_targeting_rules_replace", {
      appId: "app_local",
      environmentId: "env_local",
      flagId: "flag_checkout",
      targetingRules: [
        {
          id: "rule_paid",
          flagId: "flag_checkout",
          priority: 0,
          conditions: [],
          segmentId: "segment_paid",
          variantId: "variant_treatment",
        },
      ],
      idempotency_key: "targeting-rules-ok",
    });

    expect(result.ok).toBe(true);
    await expect(forwardedRequest?.json()).resolves.toEqual({
      targetingRules: [
        {
          id: "rule_paid",
          flagId: "flag_checkout",
          priority: 0,
          conditions: [],
          segmentId: "segment_paid",
          variantId: "variant_treatment",
        },
      ],
      idempotency_key: "targeting-rules-ok",
    });
  });

  it("keeps body-declared path fields like CreateFlag appId on the wire", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json(flag);
      },
    });

    await adapter.callOperationById("flags_create", {
      appId: "app_local",
      name: "Checkout",
      key: "checkout",
      schema: null,
      variants: [{ name: "on", value: true, isDefault: true }],
      idempotency_key: "flag-create-1",
    });

    await expect(forwardedRequest?.json()).resolves.toMatchObject({
      appId: "app_local",
      key: "checkout",
      idempotency_key: "flag-create-1",
    });
  });
});

function routeBodySchema(operationId: string) {
  const schema =
    getRoute(operationId)?.openapi.request?.body?.content?.["application/json"]?.schema;
  expect(schema && typeof (schema as { safeParse?: unknown }).safeParse === "function").toBe(true);
  return schema as {
    safeParse(
      input: unknown,
    ): { success: true } | { success: false; error: { issues: Array<{ message: string }> } };
  };
}
