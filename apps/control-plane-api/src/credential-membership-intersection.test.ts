import { describe, expect, it } from "vitest";
import { requireAppDelete, requireAppWrite } from "./app-authz";
import { ORG_MEMBER_ROLES, ORG_OWNER_ROLES, requireOrgRole } from "./org-authz";

const APP_ID = "app_scope_intersection";
const ORG_ID = "org_scope_intersection";
const OWNER_ID = "user_scope_intersection_owner";

describe("credential scope and live membership intersection", () => {
  it("keeps a Door B member credential read-only despite its live App owner membership", async () => {
    const deps = appDeps("owner");
    const actor = { id: OWNER_ID, scopes: [`app:${APP_ID}:member`] };

    const [write, remove] = await Promise.all([
      requireAppWrite(deps, APP_ID, actor, "request_write"),
      requireAppDelete(deps, APP_ID, actor, "request_delete"),
    ]);

    expect(write?.status).toBe(403);
    expect(remove?.status).toBe(403);
    await expect(write?.json()).resolves.toMatchObject({ code: "INSUFFICIENT_SCOPES" });
    await expect(remove?.json()).resolves.toMatchObject({ code: "INSUFFICIENT_SCOPES" });
  });

  it("preserves member reads while denying owner-only Org operations", async () => {
    const deps = orgDeps("owner");
    const actor = { id: OWNER_ID, scopes: [`org:${ORG_ID}:member`] };

    await expect(
      requireOrgRole(deps, ORG_ID, actor, ORG_MEMBER_ROLES, "request_read"),
    ).resolves.toBeNull();
    const ownerOnly = await requireOrgRole(deps, ORG_ID, actor, ORG_OWNER_ROLES, "request_owner");
    expect(ownerOnly?.status).toBe(403);
    await expect(ownerOnly?.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a privileged scope when live membership is insufficient", async () => {
    const appActor = { id: OWNER_ID, scopes: [`app:${APP_ID}:owner`] };
    const orgActor = { id: OWNER_ID, scopes: [`org:${ORG_ID}:owner`] };

    const [appWrite, orgWrite] = await Promise.all([
      requireAppWrite(appDeps("member"), APP_ID, appActor, "request_app_live"),
      requireOrgRole(orgDeps("member"), ORG_ID, orgActor, ORG_OWNER_ROLES, "request_org_live"),
    ]);
    expect(appWrite?.status).toBe(403);
    expect(orgWrite?.status).toBe(403);
    await expect(appWrite?.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    await expect(orgWrite?.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("never answers INSUFFICIENT_SCOPES when held scopes already include the required App role", async () => {
    const actor = { id: OWNER_ID, scopes: [`app:${APP_ID}:owner`] };
    const missingMembership = {
      repo: {
        identity: {
          getAppMembership: async () => null,
        },
      },
    };

    const denied = await requireAppDelete(missingMembership, APP_ID, actor, "request_stale_owner");
    expect(denied?.status).toBe(403);
    const body = await denied?.json();
    expect(body).toMatchObject({ code: "FORBIDDEN" });
    expect(body).not.toMatchObject({
      code: "INSUFFICIENT_SCOPES",
      details: {
        requiredScopes: [`app:${APP_ID}:owner`],
        heldScopes: [`app:${APP_ID}:owner`],
      },
    });
  });

  it("preserves admin writes and owner-only deletes when both authorities agree", async () => {
    const owner = { id: OWNER_ID, scopes: [`app:${APP_ID}:owner`] };
    const admin = { id: OWNER_ID, scopes: [`app:${APP_ID}:admin`] };

    await expect(
      requireAppWrite(appDeps("owner"), APP_ID, owner, "owner_write"),
    ).resolves.toBeNull();
    await expect(
      requireAppDelete(appDeps("owner"), APP_ID, owner, "owner_delete"),
    ).resolves.toBeNull();
    await expect(
      requireAppWrite(appDeps("admin"), APP_ID, admin, "admin_write"),
    ).resolves.toBeNull();

    const adminDelete = await requireAppDelete(appDeps("admin"), APP_ID, admin, "admin_delete");
    expect(adminDelete?.status).toBe(403);
  });
});

function appDeps(role: "owner" | "admin" | "member") {
  return {
    repo: {
      identity: {
        getAppMembership: async () => ({ role }),
      },
    },
  };
}

function orgDeps(role: "owner" | "admin" | "member") {
  return {
    repo: {
      identity: {
        getOrgMembership: async () => ({ role }),
      },
    },
  };
}
