import {
  getRoute,
  type PersonalAccessTokenGrant,
  personalAccessTokenAuthority,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { Principal } from "./principal";
import {
  narrowPersonalAccessTokenForOperation,
  narrowPersonalAccessTokenForRoute,
} from "./steps/personal-access-token-write";

const grants: PersonalAccessTokenGrant[] = [
  { target: "app:app_one", role: "owner", permissions: ["temporary_environments"] },
  { target: "app:app_two", role: "admin", permissions: ["write", "credentials"] },
];
const authority = personalAccessTokenAuthority(
  {
    organizations: [],
    apps: [
      { id: "app_one", organizationId: "org_one", role: "owner" },
      { id: "app_two", organizationId: "org_one", role: "owner" },
    ],
  },
  grants,
);
const principal: Principal = {
  kind: "control-plane-token",
  id: "user_one",
  scopes: authority.scopes,
  appId: null,
  orgId: null,
  environmentId: null,
  authDoor: "personal_access_token",
  personalAccessToken: { id: "pat_one", permissions: authority.permissions },
};
const route = getRoute("flag_config_update");
if (!route) throw new Error("missing route");

describe("Temporary Environment narrowing", () => {
  it("chooses authority per canonical App and marks only the fallback", () => {
    expect(narrowPersonalAccessTokenForRoute(route, principal, { appId: "app_one" })).toMatchObject(
      {
        ok: true,
        principal: {
          scopes: ["app:app_one:owner"],
          personalAccessToken: { temporaryEnvironmentOnly: true },
        },
      },
    );
    const ordinary = narrowPersonalAccessTokenForRoute(route, principal, { appId: "app_two" });
    expect(ordinary).toMatchObject({ ok: true, principal: { scopes: ["app:app_two:admin"] } });
    if (ordinary.ok)
      expect(ordinary.principal.personalAccessToken).not.toHaveProperty("temporaryEnvironmentOnly");
  });

  it("keeps both permission targets available for App selector discovery", () => {
    expect(narrowPersonalAccessTokenForRoute(route, principal, { appId: "my-app" })).toMatchObject({
      ok: true,
      principal: { scopes: expect.arrayContaining(["app:app_one:owner", "app:app_two:admin"]) },
    });
  });

  it.each(["flag_config_update", "flag_targeting_rules_replace", "flags_promote"])(
    "never uses temporary authority for stored %s proposals",
    (operation) => {
      expect(
        narrowPersonalAccessTokenForOperation(operation, principal, { appId: "app_one" }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "personal access token needs write permission for app:app_one",
        },
      });
    },
  );

  it.each([
    "flags_create",
    "flag_variants_create",
    "segments_create",
    "event_definitions_create",
    "metrics_create",
  ])("never opts App-level %s into temporary authority", (operation) => {
    const resource = getRoute(operation);
    if (!resource) throw new Error("missing route");
    expect(
      narrowPersonalAccessTokenForRoute(resource, principal, { appId: "app_one" }),
    ).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: expect.stringContaining("write permission") },
    });
  });
});
