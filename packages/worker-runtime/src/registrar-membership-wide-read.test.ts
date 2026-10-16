import {
  type ErrorResponse,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  routeRegistry,
} from "@splitch/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRegistrar } from "./registrar";
import { enforceScopes } from "./steps/scopes";
import { deps, okHandler, principal, resolverFor, route } from "./test-fixtures";

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("guard: membership-wide read enforcement", () => {
  it("does not let membership-wide authority satisfy a required scope", async () => {
    const wide = principal({
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: { organizations: [], apps: [] },
    });
    const reg = createRegistrar(
      deps({ authResolvers: { "control-plane-token": resolverFor(wide) } }),
    );
    const app = new Hono();
    reg.mount(
      app,
      route({
        auth: "control-plane-token",
        method: "GET",
        path: "/apps/:appId/things",
        scopes: ["flags:read"],
      }),
      okHandler,
    );

    const res = await app.request("/apps/app_1/things");
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ code: "INSUFFICIENT_SCOPES" });
  });

  it("refuses control-plane mutations except PAT handlers that enforce issuance and owner cleanup", () => {
    const wide = principal({
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: { organizations: [], apps: [] },
    });
    const mutations = routeRegistry.filter(
      (candidate) => candidate.auth === "control-plane-token" && candidate.method !== "GET",
    );

    expect(mutations.length).toBeGreaterThan(0);
    expect(
      mutations
        .filter((mutation) => mutation.operationId.startsWith("personal_access_tokens_"))
        .map((mutation) => mutation.operationId)
        .sort(),
    ).toEqual([
      "personal_access_tokens_create",
      "personal_access_tokens_revoke",
      "personal_access_tokens_revoke_all",
      "personal_access_tokens_rotate",
      "personal_access_tokens_update",
    ]);
    for (const mutation of mutations) {
      if (mutation.operationId.startsWith("personal_access_tokens_")) {
        expect(enforceScopes(mutation, wide, {}), mutation.operationId).toBeNull();
        continue;
      }
      expect(enforceScopes(mutation, wide, {}), mutation.operationId).toMatchObject({
        code: "FORBIDDEN",
        message: "credential grants read access only",
      });
    }
  });

  it("keeps selector-bound mutations allowed when their scopes and binding match", () => {
    const selectorBound = principal({
      scopes: ["flags:write"],
      appId: "app_1",
    });
    expect(
      enforceScopes(
        route({
          auth: "control-plane-token",
          method: "POST",
          path: "/apps/:appId/things",
          scopes: ["flags:write"],
        }),
        selectorBound,
        { appId: "app_1" },
      ),
    ).toBeNull();
  });
});
