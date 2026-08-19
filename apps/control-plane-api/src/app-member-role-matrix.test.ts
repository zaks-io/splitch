import { appScope, createRepository, type Repository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAppMemberHandlers } from "./app-member-handlers";
import {
  ALPHA,
  args,
  BETA,
  errorCode,
  seedTwoTenants,
  USER_ADMIN,
  USER_BETA_OWNER,
  USER_BOTH,
  USER_CANDIDATE,
  USER_MEMBER,
  USER_OUTSIDER,
  USER_OWNER,
} from "./app-settings-fixture";

/**
 * The App role matrix (organization-and-membership.md), exercised against live
 * `app_memberships` rows.
 *
 * Every principal here carries maximal App scopes, so a refusal can only come
 * from the live membership read. That is the point: the claim never decides.
 */

let dispose: () => Promise<void>;
let repo: Repository;
let handlers: ReturnType<typeof makeAppMemberHandlers>;

beforeAll(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  repo = createRepository(local.d1);
  handlers = makeAppMemberHandlers({ repo, nowIso: () => "2026-08-07T00:00:00.000Z" });
});

afterAll(async () => {
  await dispose();
});

async function roleOf(appId: string, userId: string): Promise<string | null> {
  const membership = await repo.identity.getAppMembership(appScope(appId), userId);
  return membership?.role ?? null;
}

describe("app member reads", () => {
  it("lets any App role see who else has access", async () => {
    const response = await handlers.listAppMembers(args(USER_MEMBER, ALPHA.appId, {}));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { items: { userId: string }[] };
    expect(payload.items.map((item) => item.userId).sort()).toEqual(
      [USER_ADMIN, USER_BOTH, USER_MEMBER, USER_OWNER].sort(),
    );
  });

  it("never leaks the other tenant's access list", async () => {
    const response = await handlers.listAppMembers(args(USER_BETA_OWNER, BETA.appId, {}));
    const payload = (await response.json()) as { items: { userId: string; appId: string }[] };

    expect(payload.items.map((item) => item.userId).sort()).toEqual(
      [USER_BETA_OWNER, USER_BOTH].sort(),
    );
    expect(payload.items.every((item) => item.appId === BETA.appId)).toBe(true);
  });

  it("refuses an actor with no membership in this App", async () => {
    const response = await handlers.listAppMembers(args(USER_OUTSIDER, ALPHA.appId, {}));
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
  });

  it("refuses the other tenant's owner, whose claim names this App", async () => {
    const response = await handlers.listAppMembers(args(USER_BETA_OWNER, ALPHA.appId, {}));
    expect(response.status).toBe(403);
  });
});

describe("granting App access", () => {
  it("refuses a member", async () => {
    const response = await handlers.addAppMember(
      args(USER_MEMBER, ALPHA.appId, { body: { userId: USER_CANDIDATE, role: "member" } }),
    );
    expect(response.status).toBe(403);
    expect(await roleOf(ALPHA.appId, USER_CANDIDATE)).toBeNull();
  });

  it("refuses someone who is not in the owning Organization", async () => {
    const response = await handlers.addAppMember(
      args(USER_ADMIN, ALPHA.appId, { body: { userId: USER_OUTSIDER, role: "member" } }),
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("USER_NOT_FOUND");
    expect(await roleOf(ALPHA.appId, USER_OUTSIDER)).toBeNull();
  });

  it("refuses an admin who tries to mint an owner", async () => {
    const response = await handlers.addAppMember(
      args(USER_ADMIN, ALPHA.appId, { body: { userId: USER_CANDIDATE, role: "owner" } }),
    );
    expect(response.status).toBe(403);
    expect(await roleOf(ALPHA.appId, USER_CANDIDATE)).toBeNull();
  });

  it("refuses an existing member instead of reporting the old role as a successful grant", async () => {
    const response = await handlers.addAppMember(
      args(USER_OWNER, ALPHA.appId, { body: { userId: USER_MEMBER, role: "owner" } }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "MEMBERSHIP_CONFLICT",
      message: "user is already an App member",
      details: { existingRole: "member" },
    });
    expect(await roleOf(ALPHA.appId, USER_MEMBER)).toBe("member");
  });

  it("lets an admin grant a member, scoped to this App only", async () => {
    const response = await handlers.addAppMember(
      args(USER_ADMIN, ALPHA.appId, { body: { userId: USER_CANDIDATE, role: "member" } }),
    );
    expect(response.status).toBe(200);
    expect(await roleOf(ALPHA.appId, USER_CANDIDATE)).toBe("member");
    expect(await roleOf(BETA.appId, USER_CANDIDATE)).toBeNull();
  });
});

describe("changing and revoking App access", () => {
  it("refuses an admin: role changes are owner-only", async () => {
    const response = await handlers.updateAppMember(
      args(USER_ADMIN, ALPHA.appId, {
        params: { userId: USER_MEMBER },
        body: { role: "admin" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await roleOf(ALPHA.appId, USER_MEMBER)).toBe("member");
  });

  it("changes only this App's row for a user who is in both Apps", async () => {
    const response = await handlers.updateAppMember(
      args(USER_OWNER, ALPHA.appId, {
        params: { userId: USER_BOTH },
        body: { role: "admin" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await roleOf(ALPHA.appId, USER_BOTH)).toBe("admin");
    // The same person owns the other tenant's App. That row is untouched.
    expect(await roleOf(BETA.appId, USER_BOTH)).toBe("owner");
  });

  it("refuses an admin: revoking is owner-only", async () => {
    const response = await handlers.removeAppMember(
      args(USER_ADMIN, ALPHA.appId, { params: { userId: USER_MEMBER } }),
    );
    expect(response.status).toBe(403);
    expect(await roleOf(ALPHA.appId, USER_MEMBER)).toBe("member");
  });

  it("revokes only this App's row for a user who is in both Apps", async () => {
    const response = await handlers.removeAppMember(
      args(USER_OWNER, ALPHA.appId, { params: { userId: USER_BOTH } }),
    );
    expect(response.status).toBe(200);
    expect(await roleOf(ALPHA.appId, USER_BOTH)).toBeNull();
    expect(await roleOf(BETA.appId, USER_BOTH)).toBe("owner");
  });

  it("refuses to revoke access from someone who does not have it", async () => {
    const response = await handlers.removeAppMember(
      args(USER_OWNER, ALPHA.appId, { params: { userId: USER_OUTSIDER } }),
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("USER_NOT_FOUND");
  });

  it("keeps the last owner: demotion is refused", async () => {
    const response = await handlers.updateAppMember(
      args(USER_OWNER, ALPHA.appId, {
        params: { userId: USER_OWNER },
        body: { role: "admin" },
      }),
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("LAST_OWNER_REQUIRED");
    expect(await roleOf(ALPHA.appId, USER_OWNER)).toBe("owner");
  });

  it("keeps the last owner: revoking is refused", async () => {
    const response = await handlers.removeAppMember(
      args(USER_OWNER, ALPHA.appId, { params: { userId: USER_OWNER } }),
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("LAST_OWNER_REQUIRED");
    expect(await roleOf(ALPHA.appId, USER_OWNER)).toBe("owner");
  });
});
