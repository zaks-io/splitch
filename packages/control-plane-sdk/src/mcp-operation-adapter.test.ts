import {
  getRoute,
  MCP_DELEGATION_HEADER,
  type McpDelegationReplayGuard,
  parseMcpDelegation,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { createMcpOperationAdapter } from "./mcp-operation-adapter";

const flagPage = {
  readTruncated: false,
  readLimit: 200,
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

describe("mcp operation adapter", () => {
  it("forwards flags_list by operationId for dynamic MCP tool execution", async () => {
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async () =>
        Response.json({
          ...flagPage,
          unexpectedSecretLikeField: "must-not-escape",
        }),
    });

    const result = await adapter.callOperationById("flags_list", { appId: "app_local" });

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: flagPage,
    });
  });

  it("throws for unknown operation ids", async () => {
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
    });

    await expect(adapter.callOperationById("missing_tool", {})).rejects.toThrow(
      'control-plane-sdk: unknown operation "missing_tool"',
    );
  });

  it("rejects a legacy Approval Request response without rewriting the canonical request", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json(flagConfig);
      },
    });

    await expect(
      adapter.callOperationById("flag_config_update", {
        appId: "app_local",
        environmentId: "env_local",
        flagId: "flag_checkout",
        enabled: true,
        review: { action: "approve_and_apply" },
        idempotency_key: "config-update-legacy-response",
      }),
    ).rejects.toThrow("returned an invalid response body");

    await expect(forwardedRequest?.json()).resolves.toEqual({
      enabled: true,
      review: { action: "approve_and_apply" },
      idempotency_key: "config-update-legacy-response",
    });
  });

  it("forwards the final Approval idempotency key as body and header", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json({ config: flagConfig, approvalRequest: null });
      },
    });

    await adapter.callOperationById("flag_config_update", {
      appId: "app_local",
      environmentId: "env_local",
      flagId: "flag_checkout",
      enabled: true,
      idempotency_key: "config-update-1",
    });

    expect(forwardedRequest?.headers.get("idempotency-key")).toBe("config-update-1");
    await expect(forwardedRequest?.json()).resolves.toEqual({
      enabled: true,
      idempotency_key: "config-update-1",
    });
  });

  it("uses delegation without forwarding an available bearer credential", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      authorization: "Bearer must-not-forward",
      delegationSecret: "d".repeat(32),
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json(flagPage);
      },
    });

    await adapter.callOperationById(
      "flags_list",
      { appId: "app_local" },
      {
        authorization: "Bearer also-must-not-forward",
        delegation: {
          subject: "user_mcp",
          scopes: ["app:app_local:admin", "app:app_unrelated:owner", "org:org_unrelated:owner"],
          authDoor: "id_jag",
        },
      },
    );

    expect(forwardedRequest?.headers.get("authorization")).toBeNull();
    expect(forwardedRequest?.headers.get(MCP_DELEGATION_HEADER)).not.toBeNull();
    await expect(delegatedActor(forwardedRequest, "control-plane-api")).resolves.toEqual({
      subject: "user_mcp",
      scopes: ["app:app_local:admin"],
      authDoor: "id_jag",
    });
  });

  it("delegates only the selected Organization authority for Org operations", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      delegationSecret: "d".repeat(32),
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json({ items: [] });
      },
    });

    await adapter.callOperationById(
      "apps_list",
      { orgId: "org_selected" },
      {
        delegation: {
          subject: "user_mcp",
          scopes: ["org:org_selected:owner", "org:org_unrelated:admin", "app:app_unrelated:owner"],
          authDoor: "id_jag",
        },
      },
    );

    await expect(delegatedActor(forwardedRequest, "control-plane-api")).resolves.toEqual({
      subject: "user_mcp",
      scopes: ["org:org_selected:owner"],
      authDoor: "id_jag",
    });
  });
});

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
      targetingRules: [],
      idempotency_key: "targeting-rules-ok",
    });

    expect(result.ok).toBe(true);
    await expect(forwardedRequest?.json()).resolves.toEqual({
      targetingRules: [],
      idempotency_key: "targeting-rules-ok",
    });
  });

  it("keeps body-declared path fields like CreateFlag appId on the wire", async () => {
    let forwardedRequest: Request | undefined;
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async (request) => {
        forwardedRequest = request instanceof Request ? request : new Request(request);
        return Response.json(flagPage.items[0]);
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

async function delegatedActor(request: Request | undefined, surface: "control-plane-api") {
  expect(request).toBeDefined();
  return parseMcpDelegation({
    request: request as Request,
    surface,
    secret: "d".repeat(32),
    replayGuard: memoryReplayGuard(),
  });
}

function memoryReplayGuard(): McpDelegationReplayGuard {
  return { claim: async () => true };
}

function routeBodySchema(operationId: string) {
  const schema =
    getRoute(operationId)?.openapi.request?.body?.content?.["application/json"]?.schema;
  expect(schema && typeof (schema as { safeParse?: unknown }).safeParse === "function").toBe(true);
  return schema as {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ message: string }> } };
  };
}
