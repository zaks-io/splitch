import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { DELEGATED_IDENTITY_HEADER, type Principal } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { makeAppAuditReadHarness } from "./app-audit-route-fixture";

const actor: Principal = {
  id: "user_1",
  kind: "control-plane-token",
  scopes: ["app:app_1:admin"],
  appId: "app_1",
  orgId: "org_1",
  environmentId: null,
  authDoor: "device_flow",
};
const empty = { items: [], readLimit: 50, readTruncated: false, cursor: null };
function harness(
  options: { principal?: Principal; role?: string | null; deleted?: boolean; body?: unknown } = {},
) {
  const analysisFetch = vi.fn(async (_request: RequestInfo | URL) =>
    Response.json(options.body ?? empty),
  );
  const repo = {
    identity: {
      getAppMembership: async ({ appId }: { appId: string }, userId: string) =>
        appId === "app_1" && userId === "user_1" && options.role !== null
          ? { role: options.role ?? "admin" }
          : null,
      getOrgMembership: async () => ({ role: "owner" }),
      getApp: async (appId: string) =>
        appId === "app_1" && !options.deleted ? { id: appId, organizationId: "org_1" } : null,
    },
  } as unknown as Repository;
  return {
    app: makeAppAuditReadHarness({
      repo,
      principal: options.principal ?? actor,
      analysis: { fetch: analysisFetch } as unknown as Fetcher,
    }),
    analysisFetch,
  };
}

describe("Control Plane App audit authorization", () => {
  it.each([
    ["live member with old admin credential", { role: "member" }],
    ["removed App member", { role: null }],
    ["App admin with member credential", { principal: { ...actor, scopes: ["app:app_1:member"] } }],
    [
      "Organization owner alone",
      { role: null, principal: { ...actor, scopes: ["org:org_1:owner"] } },
    ],
    ["deleted App", { deleted: true }],
    [
      "wrong credential App",
      { principal: { ...actor, appId: "app_2", scopes: ["app:app_2:admin"] } },
    ],
  ])("denies %s before the Analysis binding can call Tinybird", async (_name, options) => {
    const { app, analysisFetch } = harness(options);
    const response = await app.request("/apps/app_1/audit");
    expect([403, 404]).toContain(response.status);
    expect(analysisFetch).not.toHaveBeenCalled();
  });

  it("does not allow a cached wide membership to replace the live App role", async () => {
    const wide: Principal = {
      ...actor,
      scopes: [],
      appId: null,
      orgId: null,
      authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      memberships: {
        organizations: [{ id: "org_1", role: "owner" }],
        apps: [{ id: "app_1", organizationId: "org_1", role: "admin" }],
      },
    };
    const { app, analysisFetch } = harness({ principal: wide, role: "member" });
    expect((await app.request("/apps/app_1/audit")).status).toBe(403);
    expect(analysisFetch).not.toHaveBeenCalled();
  });

  it("delegates the authorized App and validated filters without the bearer", async () => {
    const { app, analysisFetch } = harness();
    const response = await app.request("/apps/app_1/audit?limit=2&runId=run_1", {
      headers: { authorization: "Bearer canary-not-forwarded" },
    });
    expect(response.status).toBe(200);
    const forwarded = analysisFetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(JSON.parse(forwarded.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toMatchObject({
      operation: "app_audit_list",
      appId: "app_1",
      scopes: ["app:app_1:admin"],
    });
    expect(new URL(forwarded.url).searchParams.get("runId")).toBe("run_1");
    expect(new URL(forwarded.url).searchParams.has("cursor")).toBe(false);
  });

  it("preserves a supplied pagination cursor at the delegation boundary", async () => {
    const { app, analysisFetch } = harness();
    expect((await app.request("/apps/app_1/audit?cursor=opaque-cursor")).status).toBe(200);
    const forwarded = analysisFetch.mock.calls[0]?.[0] as Request;
    expect(new URL(forwarded.url).searchParams.get("cursor")).toBe("opaque-cursor");
  });

  it("preserves the carried deleted-user tombstone through the public route", async () => {
    const event = {
      eventId: "event_deleted_actor",
      appId: "app_1",
      organizationId: "org_1",
      environmentId: null,
      actor: { type: "user", userId: "deleted-user:user_archived" },
      authDoor: "device_flow",
      action: "app_members_remove",
      resourceType: "app_member",
      resourceId: "user_removed",
      targetVersion: null,
      outcome: "committed",
      requestId: "req_1",
      approvalRequestId: null,
      runId: null,
      metadata: {},
      timestamp: "2026-08-03T00:00:00.000Z",
    };
    const { app } = harness({ body: { ...empty, items: [event] } });
    const response = await app.request("/apps/app_1/audit");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...empty, items: [event] });
  });

  it("refuses caller tenant scope and unsafe downstream fields", async () => {
    const { app, analysisFetch } = harness();
    const refused = await app.request("/apps/app_1/audit?app_id=other");
    expect(refused.status).toBe(400);
    expect(analysisFetch).not.toHaveBeenCalled();
    const unsafe = harness({ body: { ...empty, rawKey: "CANARY_SECRET" } });
    const response = await unsafe.app.request("/apps/app_1/audit");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("CANARY_SECRET");
  });
});
