import { describe, expect, it } from "vitest";
import { errorOutcomeByCode } from "./error-outcome";
import { httpStatusForError } from "./error-status";
import { ErrorResponseSchema } from "./errors";
import { CredentialCacheKVSchemaV2, CredentialCacheKVSchemaV3 } from "./index";
import { EnvironmentSchema } from "./leaf-schemas-runtime";
import { deriveMcpTools } from "./mcp-tools";
import { getRoute, routeRegistry } from "./route-registry";
import { CreateEnvironmentRequestSchema } from "./routes/route-shapes";
import { accountRoutes } from "./routes/routes-account";

const timestamp = "2026-10-17T12:00:00.000Z";
const temporary = {
  expiresAt: "2026-10-20T12:00:00.000Z",
  syncedFromEnvironmentId: "env_prod",
  syncedAt: timestamp,
};
const environment = {
  id: "env_temporary",
  appId: "app_1",
  key: "pr-123",
  name: "PR 123",
  policy: {
    variantAvailability: "allow",
    targetingRolloutValue: "allow",
    enabledState: "allow",
    startExperimentRun: "allow",
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("Temporary Environment contracts", () => {
  it("requires an explicit kind and complete ISO expiry and Sync provenance", () => {
    expect(EnvironmentSchema.parse({ ...environment, temporary: null }).temporary).toBeNull();
    expect(EnvironmentSchema.parse({ ...environment, temporary }).temporary).toEqual(temporary);
    for (const invalid of [
      undefined,
      {},
      { ...temporary, expiresAt: "invalid" },
      {
        ...temporary,
        syncedAt: "2026-10-17",
      },
    ]) {
      expect(EnvironmentSchema.safeParse({ ...environment, temporary: invalid }).success).toBe(
        false,
      );
    }
  });

  it("accepts permanent creates and strict nested temporary requests without changing the Policy refusal path", () => {
    const schema = CreateEnvironmentRequestSchema;
    expect(schema).toBeDefined();
    expect(schema?.parse({ key: "staging" })).toEqual({ key: "staging" });
    const body = {
      key: "pr-123",
      temporary: { fromEnvironmentId: "prod", expiresAt: temporary.expiresAt },
    };
    expect(schema?.parse(body)).toEqual(body);
    // Policy with temporary is a domain refusal, not a request-shape failure.
    expect(schema?.safeParse({ ...body, policy: environment.policy }).success).toBe(true);
    for (const temporary of [
      null,
      {},
      { fromEnvironmentId: "" },
      {
        fromEnvironmentId: "prod",
        expiresAt: "2026-10-20",
      },
      { fromEnvironmentId: "prod", extra: true },
    ]) {
      expect(schema?.safeParse({ key: "pr-123", temporary }).success).toBe(false);
    }
  });

  it("derives create, Sync and delete MCP inputs from the route contracts", () => {
    const tools = new Map(deriveMcpTools().map((tool) => [tool.name, tool]));
    expect(
      tools.get("environments_create")?.inputSchema.parse({
        appId: "app_1",
        key: "pr-123",
        temporary: { fromEnvironmentId: "prod" },
      }),
    ).toMatchObject({ temporary: { fromEnvironmentId: "prod" } });
    const sync = tools.get("environments_sync");
    expect(
      sync?.inputSchema.parse({
        appId: "app_1",
        environmentId: "pr-123",
        by: "id",
        fromEnvironmentId: "dev",
      }),
    ).toMatchObject({ fromEnvironmentId: "dev", by: "id" });
    expect(sync?.inputSchema.safeParse({ appId: "app_1", environmentId: "pr-123" }).success).toBe(
      false,
    );
    expect(sync?.outputSchema.parse({ ...environment, temporary, syncedFlags: 3 })).toMatchObject({
      temporary,
      syncedFlags: 3,
    });
    expect(
      tools.get("environments_delete")?.inputSchema.parse({
        appId: "app_1",
        environmentId: "pr-123",
      }),
    ).toMatchObject({ environmentId: "pr-123" });
  });

  it("appends Sync after every existing account route used by the typed SDK", () => {
    expect(accountRoutes.slice(15).map((route) => route.operationId)).toEqual([
      "environments_list",
      "environments_create",
      "environments_get",
      "environments_update",
      "environments_delete",
      "app_members_list",
      "app_members_add",
      "app_members_update",
      "app_members_remove",
      "environments_sync",
    ]);
    expect(getRoute("environments_sync")).toMatchObject({
      method: "POST",
      path: "/apps/:appId/envs/:environmentId/sync",
      permission: "write",
      effects: { mutates: true, idempotent: true },
    });
  });

  it("declares expiry on every registry route that authenticates an SDK key", () => {
    const routes = routeRegistry.filter((route) =>
      ["client-key", "api-key", "data-plane-key"].includes(route.auth),
    );
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes)
      expect(route.errors, route.operationId).toContain("ENVIRONMENT_EXPIRED");
  });

  it("declares Environment mutation expiry by effects, including provisioning GET and excluding read-only POST", () => {
    const routes = routeRegistry.filter(
      (route) =>
        route.auth === "control-plane-token" &&
        /:(?:environmentId|targetEnvironmentId)(?:\/|$)/.test(route.path),
    );
    for (const route of routes) {
      expect(route.errors.includes("ENVIRONMENT_EXPIRED"), route.operationId).toBe(
        route.effects.mutates && route.operationId !== "environments_delete",
      );
    }
    expect(getRoute("client_key_get")?.effects.mutates).toBe(true);
    expect(getRoute("experiment_plan")?.effects.mutates).toBe(false);
    expect(getRoute("experiment_results_post")?.effects.mutates).toBe(false);
    expect(getRoute("flags_test_eval")?.effects.mutates).toBe(false);
  });

  it("exports separate v2 and v3 cache schemas without widening v2", () => {
    const credential = {
      appId: "app_1",
      environmentId: "env_prod",
      credentialSchemaVersion: 2,
      organizationId: "org_1",
      kind: "api_key",
      scopes: ["data-plane:evaluate"],
      revoked: false,
      cachedAt: timestamp,
    };
    expect(CredentialCacheKVSchemaV2.parse(credential)).toEqual(credential);
    expect(
      CredentialCacheKVSchemaV3.parse({
        ...credential,
        credentialSchemaVersion: 3,
        expiresAt: temporary.expiresAt,
      }).expiresAt,
    ).toBe(temporary.expiresAt);
    expect(CredentialCacheKVSchemaV2.safeParse({ ...credential, expiresAt: null }).success).toBe(
      false,
    );
  });
});

describe("Temporary Environment errors", () => {
  const cases = [
    [
      "ENVIRONMENT_EXPIRED",
      410,
      "user_action_required",
      {
        environmentId: "env_temporary",
        expiredAt: temporary.expiresAt,
        recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT",
      },
    ],
    [
      "ENVIRONMENT_KIND_UNSUPPORTED",
      409,
      "non_retryable",
      {
        environmentId: "env_prod",
        temporary: false,
        attemptedOp: "environments_sync",
      },
    ],
    [
      "TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED",
      409,
      "user_action_required",
      {
        appId: "app_1",
        limit: 50,
        active: 50,
        nextExpiresAt: temporary.expiresAt,
        recommendedAction: "DELETE_TEMPORARY_ENVIRONMENT",
      },
    ],
    ["SYNC_LIMIT_EXCEEDED", 409, "non_retryable", { appId: "app_1", limit: 500, flags: 501 }],
    [
      "ENVIRONMENT_SYNC_INCOMPLETE",
      503,
      "retryable",
      {
        environmentId: "env_temporary",
        fromEnvironmentId: "env_prod",
        applied: 2,
        failed: 1,
        failedFlagIds: ["flag_1"],
        retryAfterMs: 1000,
      },
    ],
  ] as const;

  it.each(cases)("validates %s status, outcome and details", (code, status, outcome, details) => {
    expect(ErrorResponseSchema.parse({ code, message: code, details }).details).toEqual(details);
    expect(httpStatusForError(code)).toBe(status);
    expect(errorOutcomeByCode[code]).toBe(outcome);
  });

  it("rejects non-ISO expiredAt and caps incomplete Sync failure details", () => {
    expect(
      ErrorResponseSchema.safeParse({
        code: "ENVIRONMENT_EXPIRED",
        message: "expired",
        details: { ...cases[0][3], expiredAt: "invalid" },
      }).success,
    ).toBe(false);
    expect(
      ErrorResponseSchema.safeParse({
        code: "ENVIRONMENT_SYNC_INCOMPLETE",
        message: "incomplete",
        details: { ...cases[4][3], failedFlagIds: Array.from({ length: 51 }, () => "flag_1") },
      }).success,
    ).toBe(false);
  });

  it("reuses SLUG_CONFLICT for Environment keys with the existing remedy", () => {
    const error = {
      code: "SLUG_CONFLICT",
      message: "Environment key is taken",
      details: {
        resourceType: "environment",
        conflictingSlug: "pr-123",
        recommendedAction: "CHOOSE_DIFFERENT_SLUG",
      },
    };
    expect(ErrorResponseSchema.parse(error)).toEqual(error);
    expect(
      ErrorResponseSchema.safeParse({
        ...error,
        details: {
          ...error.details,
          recommendedAction: "CHOOSE_DIFFERENT_KEY",
        },
      }).success,
    ).toBe(false);
  });
});
