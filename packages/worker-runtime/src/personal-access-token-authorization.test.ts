import {
  getRoute,
  type PersonalAccessTokenGrant,
  personalAccessTokenAuthority,
} from "@splitch/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "./principal";
import { createRegistrar } from "./registrar";
import {
  narrowPersonalAccessTokenForOperation,
  narrowPersonalAccessTokenForPermission,
} from "./steps/personal-access-token-write";

function principal(grants: PersonalAccessTokenGrant[]): Principal {
  const authority = personalAccessTokenAuthority(
    {
      organizations: [{ id: "org_one", role: "owner" }],
      apps: [
        { id: "app_one", organizationId: "org_one", role: "owner" },
        { id: "app_two", organizationId: "org_one", role: "owner" },
      ],
    },
    grants,
  );
  return {
    kind: "control-plane-token",
    id: "user_one",
    scopes: authority.scopes,
    orgId: null,
    appId: null,
    environmentId: null,
    authDoor: "personal_access_token",
    liveMembership: true,
    personalAccessToken: { id: "pat_one", permissions: authority.permissions },
  };
}

const writer = principal([{ target: "all", role: "admin", permissions: ["write"] }]);

describe("stored proposal permission and role checks", () => {
  it("allows writes and winner Promotion, while refusing deletion for a write token", () => {
    for (const operation of ["flags_promote", "experiments_start", "experiment_winner_promote"]) {
      expect(
        narrowPersonalAccessTokenForOperation(operation, writer, { appId: "app_one" }),
      ).toMatchObject({
        ok: true,
        principal: { appId: "app_one" },
      });
    }
    for (const operation of ["flags_delete", "flag_variants_delete"]) {
      expect(
        narrowPersonalAccessTokenForOperation(operation, writer, { appId: "app_one" }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "personal access token needs delete permission for app:app_one",
        },
      });
    }
  });

  it("checks the permission's role ceiling on the exact target", () => {
    const mixed = principal([
      { target: "org:org_one", role: "member", permissions: ["write", "delete"] },
      { target: "app:app_one", role: "admin", permissions: ["credentials"] },
      { target: "app:app_two", role: "admin", permissions: ["delete"] },
    ]);
    for (const operation of ["flags_promote", "flags_delete"]) {
      expect(
        narrowPersonalAccessTokenForOperation(operation, mixed, { appId: "app_one" }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: expect.stringContaining("at admin role for app:app_one"),
        },
      });
    }
    expect(
      narrowPersonalAccessTokenForOperation("flags_delete", mixed, { appId: "app_two" }),
    ).toMatchObject({ ok: true });
    expect(
      narrowPersonalAccessTokenForOperation("api_keys_create", mixed, { appId: "app_one" }),
    ).toMatchObject({ ok: true });
  });

  it("reflects a newly demoted current principal and fails closed for unknown operations", () => {
    const demoted = principal([{ target: "all", role: "member", permissions: ["write"] }]);
    expect(
      narrowPersonalAccessTokenForOperation("flags_promote", demoted, { appId: "app_one" }),
    ).toMatchObject({ ok: false });
    expect(
      narrowPersonalAccessTokenForOperation("unknown", writer, { appId: "app_one" }),
    ).toMatchObject({ ok: false });
  });

  it("selects write authority for decline without borrowing another permission's admin ceiling", () => {
    const mixed = principal([
      { target: "all", role: "member", permissions: ["write"] },
      { target: "all", role: "admin", permissions: ["delete"] },
    ]);
    expect(
      narrowPersonalAccessTokenForPermission(
        "write",
        mixed,
        { appId: "app_one" },
        { targeted: true },
      ),
    ).toMatchObject({
      ok: true,
      principal: { scopes: ["app:app_one:member", "app:app_two:member", "org:org_one:member"] },
    });
  });
});

describe("registrar PAT permission checks", () => {
  async function requestTo(selector: string, granted: Principal, resolution: "allow" | "deny") {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const resolver = vi.fn(({ principal: resolvedPrincipal, input, params }) =>
      resolution === "allow"
        ? {
            ok: true as const,
            principal: { ...resolvedPrincipal, appId: "app_one" },
            input,
            params: { ...params, appId: "app_one" },
          }
        : {
            ok: false as const,
            error: { code: "APP_NOT_FOUND" as const, message: "app not found", details: {} },
          },
    );
    const app = new Hono();
    const route = getRoute("flags_update");
    if (!route) throw new Error("missing flags_update route");
    createRegistrar({
      authResolvers: { "control-plane-token": () => ({ ok: true, principal: granted }) },
      rateLimiter: () => ({ limited: false }),
      authenticatedInputResolver: resolver,
    }).mount(app, route, handler);
    const response = await app.request(`/apps/${selector}/flags/flag_one`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": "request-one" },
      body: JSON.stringify({ name: "Updated" }),
    });
    return { response, resolver, handler };
  }

  it("supplies only permission scopes to the selector and then executes the handler", async () => {
    const granted = principal([{ target: "app:app_one", role: "admin", permissions: ["write"] }]);
    const { response, resolver, handler } = await requestTo("my-app", granted, "allow");
    expect(response.status).toBe(200);
    expect(resolver.mock.calls[0]?.[0].principal.scopes).toEqual(["app:app_one:admin"]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("retains the permission and slug when the narrowed selector cannot resolve the target", async () => {
    const granted = principal([
      { target: "app:app_one", role: "admin", permissions: [] },
      { target: "app:app_two", role: "admin", permissions: ["write"] },
    ]);
    const { response, resolver, handler } = await requestTo("my-app", granted, "deny");
    expect(resolver.mock.calls[0]?.[0].principal.scopes).toEqual(["app:app_two:admin"]);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("write permission for app:my-app"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses absent permission before selector resolution", async () => {
    const readOnly = principal([{ target: "app:app_one", role: "admin", permissions: [] }]);
    const { response, resolver, handler } = await requestTo("my-app", readOnly, "allow");
    expect(response.status).toBe(403);
    expect(resolver).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
