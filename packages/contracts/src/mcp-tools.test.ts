import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorResponseSchema } from "./errors";
import { KILL_SWITCH_OFF_EXEMPTION } from "./kill-switch-off-exemption";
import { deriveMcpTools, isMcpToolRoute } from "./mcp-tools";
import { getRoute, routeRegistry } from "./route-registry";

/**
 * MCP tools are derived from the registry and proven HERE — never committed. The
 * critical assertions are surface isolation (no data-plane tool, no auth/scope in
 * the tool schema) and 1:1 parity (one tool per control-plane route, with the
 * route's operationId/input/output).
 */

const tools = deriveMcpTools();
const toolNames = new Set(tools.map((tool) => tool.name));

// Routes that MUST NOT become MCP tools: the data-plane SDK endpoints and the
// public OpenAPI discovery doc. Listed explicitly so a future data-plane route
// leaking into the tool set fails loudly here.
const NON_TOOL_OPERATION_IDS = [
  "sdk_evaluate",
  "sdk_cached_evaluation_telemetry",
  "sdk_peek",
  "sdk_verify",
  "sdk_evaluate_all",
  "sdk_exposures",
  "sdk_track",
  "convex_installations_create",
  "convex_installations_get",
  "convex_installations_delete",
  "convex_secret_rotations_create",
  "convex_snapshot_get",
  "convex_exposures_create",
  "cloudflare_installations_create",
  "cloudflare_installations_get",
  "cloudflare_installations_delete",
  "cloudflare_exposures_create",
  "openapi_document_get",
  "environment_exposure_status_delete",
  "holdover_write_outbox_delete",
  "entity_assignment_privacy_export",
  "entity_assignment_privacy_delete",
  "entity_analysis_privacy_export",
  "entity_analysis_privacy_suppress",
  "entity_analysis_privacy_delete",
  "entity_event_privacy_export",
  "entity_event_privacy_suppress",
  "entity_event_privacy_delete",
  "organizations_delete",
  "current_user_privacy_export",
  "current_user_delete",
  "organization_privacy_export",
  "app_privacy_export",
  "entity_privacy_export",
  "entity_privacy_delete",
  "privacy_requests_get",
] as const;

describe("mcp tools: surface isolation (CRITICAL)", () => {
  it("derives NO tool for the data-plane Evaluation endpoints", () => {
    expect(toolNames.has("sdk_evaluate")).toBe(false);
    expect(toolNames.has("sdk_cached_evaluation_telemetry")).toBe(false);
    expect(toolNames.has("sdk_peek")).toBe(false);
    expect(toolNames.has("sdk_verify")).toBe(false);
    expect(toolNames.has("sdk_evaluate_all")).toBe(false);
    expect(toolNames.has("sdk_exposures")).toBe(false);
    expect(toolNames.has("sdk_track")).toBe(false);
  });

  it("derives NO tool for the public OpenAPI discovery doc", () => {
    expect(toolNames.has("openapi_document_get")).toBe(false);
  });

  it("derives NO tool for binding-only analytics cleanup", () => {
    expect(toolNames.has("environment_exposure_status_delete")).toBe(false);
    expect(toolNames.has("holdover_write_outbox_delete")).toBe(false);
    expect(toolNames.has("entity_assignment_privacy_export")).toBe(false);
    expect(toolNames.has("entity_assignment_privacy_delete")).toBe(false);
    expect(toolNames.has("entity_analysis_privacy_export")).toBe(false);
    expect(toolNames.has("entity_analysis_privacy_suppress")).toBe(false);
    expect(toolNames.has("entity_analysis_privacy_delete")).toBe(false);
    expect(toolNames.has("entity_event_privacy_export")).toBe(false);
    expect(toolNames.has("entity_event_privacy_suppress")).toBe(false);
    expect(toolNames.has("entity_event_privacy_delete")).toBe(false);
  });

  it("derives NO tool for operations without a backing workflow", () => {
    expect(toolNames.has("organizations_delete")).toBe(false);
    expect(toolNames.has("current_user_privacy_export")).toBe(false);
    expect(toolNames.has("privacy_requests_get")).toBe(false);
  });

  it("every excluded route is genuinely in the registry but not a tool", () => {
    for (const id of NON_TOOL_OPERATION_IDS) {
      const route = getRoute(id);
      expect(route).toBeDefined();
      if (route === undefined) {
        throw new Error(`missing route ${id}`);
      }
      expect(isMcpToolRoute(route)).toBe(false);
      expect(toolNames.has(id)).toBe(false);
    }
  });

  it("every derived tool comes from a control-plane (token-authed) route", () => {
    for (const tool of tools) {
      const route = getRoute(tool.name);
      expect(route?.auth).toBe("control-plane-token");
    }
  });

  it("no tool definition carries the route's auth/scope guard metadata", () => {
    // A tool exposes only call shape: name/description/input/output/error. The
    // route's `auth` kind and `scopes` allow-list are guard metadata the Worker
    // enforces (surfaced via UNAUTHORIZED / INSUFFICIENT_SCOPES), never copied onto
    // the tool. (A domain field that happens to be named `scopes` in a request body
    // — e.g. the scopes a new API Key grants — is legitimate tool input, distinct
    // from the route's own guard scopes; this asserts the guard metadata, not body
    // field names.)
    for (const tool of tools) {
      const keys = Object.keys(tool);
      expect(keys).toEqual(["name", "description", "inputSchema", "outputSchema", "errorSchema"]);
      const route = getRoute(tool.name);
      expect(route).toBeDefined();
      if (route === undefined) {
        throw new Error(`missing route ${tool.name}`);
      }
      const asRecord = tool as unknown as Record<string, unknown>;
      expect(asRecord.auth).toBeUndefined();
      expect(asRecord.scopes).toBeUndefined();
      // The route itself does carry guard metadata; prove the tool dropped it.
      expect(route.auth).toBe("control-plane-token");
    }
  });
});

describe("mcp tools: 1:1 parity with control-plane routes", () => {
  it("derives the Convex and Cloudflare operator installation tools", () => {
    for (const operationId of [
      "convex_installations_list",
      "convex_installations_revoke",
      "cloudflare_installations_list",
      "cloudflare_installations_revoke",
    ]) {
      expect(toolNames.has(operationId)).toBe(true);
    }
  });

  it("derives the Organization usage read tool and its flat Org input", () => {
    const usage = tools.find((tool) => tool.name === "organization_usage_get");
    const route = getRoute("organization_usage_get");
    const ok = route?.openapi.responses[200];
    const schema = ok && "content" in ok ? ok.content?.["application/json"]?.schema : undefined;

    expect(usage).toBeDefined();
    expect(objectShape(usage?.inputSchema)).toHaveProperty("orgId");
    expect(usage?.outputSchema).toBe(schema);
  });

  it("derives the Environment Exposure status tool with both tenant axes", () => {
    const status = tools.find((tool) => tool.name === "environment_exposure_status_get");

    expect(status).toBeDefined();
    expect(objectShape(status?.inputSchema)).toEqual(
      expect.objectContaining({ appId: expect.anything(), environmentId: expect.anything() }),
    );
  });

  it("accepts human App, Environment, and Flag selectors in derived tool input", () => {
    const config = tools.find((tool) => tool.name === "flag_config_get");
    const shape = objectShape(config?.inputSchema);

    expect(
      config?.inputSchema.safeParse({
        appId: "neuron",
        environmentId: "production",
        flagId: "checkout",
      }).success,
    ).toBe(true);
    expect((shape.appId as z.ZodTypeAny | undefined)?.description).toContain("App ID");
    expect((shape.environmentId as z.ZodTypeAny | undefined)?.description).toContain(
      "Environment ID",
    );
    expect((shape.flagId as z.ZodTypeAny | undefined)?.description).toContain("Flag ID");
  });

  it("derives the Organization create tool with a body-only input (SPL-171)", () => {
    const create = tools.find((tool) => tool.name === "organizations_create");
    const shape = objectShape(create?.inputSchema);

    expect(create).toBeDefined();
    expect(shape).toHaveProperty("name");
    expect(shape).toHaveProperty("slug");
    // The Org does not exist yet, so an orgId input would be meaningless.
    expect(shape).not.toHaveProperty("orgId");
  });

  it("derives Approval Request reads, filters, and Review creation from the registry", () => {
    const list = tools.find((tool) => tool.name === "approval_requests_list");
    const get = tools.find((tool) => tool.name === "approval_requests_get");
    const review = tools.find((tool) => tool.name === "approval_request_reviews_create");
    const id = "apr_01J00000000000000000000000";

    expect(list).toBeDefined();
    expect(list?.inputSchema.safeParse({ appId: "app_1", limit: "25" }).success).toBe(true);
    expect(
      list?.inputSchema.safeParse({
        appId: "app_1",
        status: "pending",
        target_kind: "flag_configuration",
        environmentId: "env_prod",
      }).success,
    ).toBe(true);

    expect(get).toBeDefined();
    expect(get?.inputSchema.safeParse({ appId: "app_1", id }).success).toBe(true);
    expect(get?.outputSchema).toBe(getRoute("approval_requests_get")?.output);

    expect(review).toBeDefined();
    expect(
      review?.inputSchema.safeParse({
        appId: "app_1",
        id,
        action: "approve_and_apply",
        idempotency_key: "review-1",
      }).success,
    ).toBe(true);
  });

  it("derives exactly one tool per control-plane route", () => {
    const controlPlaneIds = routeRegistry.filter(isMcpToolRoute).map((route) => route.operationId);
    expect([...toolNames].sort()).toEqual([...controlPlaneIds].sort());
    expect(tools.length).toBe(controlPlaneIds.length);
  });

  it("covers a non-trivial number of tools (N > 0) and excludes non-tools", () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBe(routeRegistry.length - NON_TOOL_OPERATION_IDS.length);
  });

  it("tool name equals the route operationId", () => {
    for (const tool of tools) {
      expect(getRoute(tool.name)).toBeDefined();
    }
  });
});

describe("mcp tools: derived input and output schemas", () => {
  it("tool input combines route path, query, and body fields in SDK call shape", () => {
    const create = tools.find((tool) => tool.name === "flags_create");
    const createShape = objectShape(create?.inputSchema);
    expect(Object.keys(createShape)).toEqual(
      expect.arrayContaining(["appId", "name", "key", "schema", "variants"]),
    );

    const list = tools.find((tool) => tool.name === "flags_list");
    const listShape = objectShape(list?.inputSchema);
    expect(Object.keys(listShape)).toEqual(
      expect.arrayContaining(["appId", "include", "envs", "summary"]),
    );
    expect(list?.inputSchema.safeParse({ appId: "app_1", summary: true }).success).toBe(true);
    expect(
      list?.inputSchema.safeParse({ appId: "app_1", include: "config", envs: "env_dev,env_prod" })
        .success,
    ).toBe(true);
    expect(list?.description).toContain("complete per-Environment Flag Configurations");
    expect(list?.description).toContain("by default");

    const get = tools.find((tool) => tool.name === "flags_get");
    expect(Object.keys(objectShape(get?.inputSchema))).toContain("summary");
    expect(
      get?.inputSchema.safeParse({
        appId: "app_1",
        flagId: "checkout",
        include: "config",
        envs: "env_prod",
      }).success,
    ).toBe(true);
    expect(get?.description).toContain(
      "running Experiment references for every Environment in the App by default",
    );

    const update = tools.find((tool) => tool.name === "flags_update");
    const updateShape = objectShape(update?.inputSchema);
    expect(Object.keys(updateShape)).toEqual(
      expect.arrayContaining(["appId", "flagId", "name", "schema", "description"]),
    );
    expect(
      update?.inputSchema.safeParse({ appId: "app_1", flagId: "flag_1", name: "Checkout" }).success,
    ).toBe(true);
    expect(update?.inputSchema.safeParse({ name: "Checkout" }).success).toBe(false);
  });

  it("apps_delete advertises dryRun and force for MCP/CLI parity (SPL-326)", () => {
    const del = tools.find((tool) => tool.name === "apps_delete");
    const shape = objectShape(del?.inputSchema);
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(["appId", "dryRun", "force"]));
    expect(del?.inputSchema.safeParse({ appId: "app_1", dryRun: true }).success).toBe(true);
    expect(del?.inputSchema.safeParse({ appId: "app_1", force: true }).success).toBe(true);
    expect(z.toJSONSchema(del?.inputSchema as z.ZodTypeAny).properties).toMatchObject({
      dryRun: { type: "boolean" },
      force: { type: "boolean" },
    });
  });

  it("flag_config_update description carries the kill-switch-off exemption (SPL-312)", () => {
    const update = tools.find((tool) => tool.name === "flag_config_update");
    expect(update?.description).toContain(KILL_SWITCH_OFF_EXEMPTION);
    expect(getRoute("flag_config_update")?.summary).not.toContain(KILL_SWITCH_OFF_EXEMPTION);
  });

  it("tool output = the route 200 response schema", () => {
    const get = tools.find((tool) => tool.name === "flags_get");
    const ok = getRoute("flags_get")?.openapi.responses[200];
    const schema = ok && "content" in ok ? ok.content?.["application/json"]?.schema : undefined;
    expect(get?.outputSchema).toBe(schema);
  });

  it("every tool shares the one ErrorResponse schema", () => {
    for (const tool of tools) {
      expect(tool.errorSchema).toBe(ErrorResponseSchema);
    }
  });
});

function objectShape(schema: unknown): Record<string, unknown> {
  return (schema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
}
