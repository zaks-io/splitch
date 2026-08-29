import { getRoute, MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  delegatedAuthResolver,
  delegatedIdentityFor,
  delegatedIdentityFrom,
  delegatedRequest,
} from "./delegation";
import type { Principal } from "./principal";
import { enforceScopes } from "./steps/scopes";

const ORG = "org_own";
const APP = "app_own";
const OTHER_APP = "app_other";
const ENVIRONMENT = "env_own";

const wide: Principal = {
  kind: "control-plane-token",
  id: "user_1",
  scopes: [],
  orgId: null,
  appId: null,
  environmentId: null,
  authDoor: "id_jag",
  authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  memberships: {
    organizations: [{ id: ORG, role: "admin" }],
    apps: [
      { id: APP, organizationId: ORG, role: "admin" },
      { id: OTHER_APP, organizationId: ORG, role: "member" },
    ],
  },
};

describe("membership-wide delegation", () => {
  it("carries live Organization authority and rechecks it downstream", async () => {
    const route = requiredRoute("organization_usage_get");
    const identity = delegatedIdentityFrom(route, wide, { orgId: ORG });

    expect(identity).toMatchObject({
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: wide.memberships,
      orgId: ORG,
    });
    expect(
      delegatedIdentityFor(delegatedRequest(route, identity, { params: { orgId: ORG } }), [route]),
    ).toEqual(identity);
    expect(
      delegatedIdentityFor(
        delegatedRequest(route, identity, { params: { orgId: "org_foreign" } }),
        [route],
      ),
    ).toBeNull();

    const principal = await resolved(identity);
    expect(enforceScopes(route, principal, { orgId: ORG })).toBeNull();
    expect(enforceScopes(route, principal, { orgId: "org_foreign" })).toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("carries live App authority and rechecks it downstream", async () => {
    const route = requiredRoute("experiment_results_get");
    const params = { appId: APP, environmentId: ENVIRONMENT, experimentId: "exp_1" };
    const identity = delegatedIdentityFrom(route, wide, params);

    expect(identity).toMatchObject({
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: wide.memberships,
      appId: APP,
      environmentId: ENVIRONMENT,
    });
    expect(delegatedIdentityFor(delegatedRequest(route, identity, { params }), [route])).toEqual(
      identity,
    );
    expect(
      delegatedIdentityFor(
        delegatedRequest(route, identity, { params: { ...params, appId: OTHER_APP } }),
        [route],
      ),
    ).toBeNull();

    const principal = await resolved(identity);
    expect(enforceScopes(route, principal, params)).toBeNull();
    expect(enforceScopes(route, principal, { ...params, appId: "app_foreign" })).toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects a delegated App axis absent from the carried live memberships", () => {
    const route = requiredRoute("experiment_results_get");
    const params = { appId: APP, environmentId: ENVIRONMENT, experimentId: "exp_1" };
    const identity = delegatedIdentityFrom(route, wide, params);
    const memberships = wide.memberships;
    if (!memberships) throw new Error("wide test principal has no memberships");
    const missingApp = {
      ...identity,
      memberships: {
        organizations: memberships.organizations,
        apps: [{ id: OTHER_APP, organizationId: ORG, role: "member" as const }],
      },
    };

    expect(
      delegatedIdentityFor(delegatedRequest(route, missingApp, { params }), [route]),
    ).toBeNull();
  });

  it("rejects wide authority combined with selector scopes", () => {
    const route = requiredRoute("experiment_results_get");
    const params = { appId: APP, environmentId: ENVIRONMENT, experimentId: "exp_1" };
    const identity = {
      ...delegatedIdentityFrom(route, wide, params),
      scopes: [`app:${APP}:admin`],
    };

    expect(delegatedIdentityFor(delegatedRequest(route, identity, { params }), [route])).toBeNull();
  });
});

function requiredRoute(operationId: string) {
  const route = getRoute(operationId);
  if (!route) throw new Error(`missing route ${operationId}`);
  return route;
}

async function resolved(identity: ReturnType<typeof delegatedIdentityFrom>): Promise<Principal> {
  const result = await delegatedAuthResolver(identity)(new Request("https://owner.internal"));
  if (!result.ok) throw new Error("delegated identity was refused");
  return result.principal;
}
