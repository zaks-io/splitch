import { describe, expect, it } from "vitest";
import { type ApiRouteContract, defineApiRoute, z } from "./openapi-route";
import { PersonalAccessTokenGrantSchema } from "./personal-access-tokens";
import { updateClosed } from "./route-effects";
import { assertRegistry, routeRegistry } from "./route-registry";

describe("Temporary Environment permission contracts", () => {
  it("accepts the permission without adding grant targets or syntax", () => {
    expect(
      PersonalAccessTokenGrantSchema.parse({
        target: "app:app_one",
        role: "owner",
        permissions: ["temporary_environments"],
      }).permissions,
    ).toEqual(["temporary_environments"]);
    expect(
      PersonalAccessTokenGrantSchema.safeParse({
        target: "env:env_one",
        role: "owner",
        permissions: ["temporary_environments"],
      }).success,
    ).toBe(false);
  });

  it("pins exactly the opted-in routes", () => {
    expect(
      routeRegistry
        .filter((route) => route.temporaryEnvironment)
        .map((route) => route.id)
        .sort(),
    ).toEqual([
      "api_keys_create",
      "api_keys_revoke",
      "client_key_get",
      "client_key_rotate",
      "client_key_update",
      "environments_create",
      "environments_delete",
      "environments_sync",
      "environments_update",
      "flag_config_update",
      "flag_targeting_rules_replace",
      "flags_promote",
    ]);
  });

  it("rejects an opt-in without an Environment path parameter at registry load", () => {
    const route = defineApiRoute({
      operationId: "unsafe_update",
      owner: "control-plane-api",
      method: "PATCH",
      path: "/apps/:appId/things",
      summary: "Update a thing",
      response: z.object({ ok: z.boolean() }),
      auth: "control-plane-token",
      permission: "write",
      temporaryEnvironment: true,
      rateLimit: "none",
      idempotency: "none",
      errors: [],
      effects: updateClosed,
    });
    expect(() => assertRegistry([route])).toThrow(/Environment path parameter/);
    for (const path of [
      "/apps/:appId/envs/:environmentId",
      "/apps/:appId/promote/:targetEnvironmentId",
    ]) {
      expect(() => assertRegistry([{ ...route, path } as ApiRouteContract])).not.toThrow();
    }
    expect(() =>
      assertRegistry([{ ...route, operationId: "environments_create", id: "environments_create" }]),
    ).not.toThrow();
  });
});
