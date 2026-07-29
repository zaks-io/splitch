import { deriveMcpTools, getRoute } from "@splitch/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN,
  bodyOf,
  client,
  MEMBER,
  memberResourceRoute,
  memberRoute,
  NEW_MEMBER,
  NOW_ISO,
  OWNER,
  orgRoute,
  PRIMARY,
  SOLO,
  SOLO_OWNER,
  seedOrgs,
  setup,
  teardown,
  token,
} from "./org-members-harness";

beforeAll(seedOrgs);
beforeEach(setup);
afterEach(teardown);

describe("control-plane org/member endpoints", () => {
  it("round-trips Org patch and member CRUD through the mounted Worker", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const api = client(ownerJwt);

    const orgs = orgRoute(api);
    const members = memberRoute(api);
    const memberResource = memberResourceRoute(api);

    const updatedOrg = await orgs.$patch({
      param: { orgId: PRIMARY.orgId },
      json: { name: "Ledger Renamed", plan: "pro" },
    });
    expect(updatedOrg.status).toBe(200);
    expect(await updatedOrg.json()).toMatchObject({
      id: PRIMARY.orgId,
      name: "Ledger Renamed",
      plan: "pro",
      updatedAt: NOW_ISO,
    });

    const added = await members.$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "admin" },
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      id: NEW_MEMBER,
      email: "new@example.test",
      organizationId: PRIMARY.orgId,
      role: "admin",
    });

    const changed = await memberResource.$patch({
      param: { orgId: PRIMARY.orgId, userId: NEW_MEMBER },
      json: { role: "member" },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ id: NEW_MEMBER, role: "member" });

    const listed = await members.$get({
      param: { orgId: PRIMARY.orgId },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { items: unknown[] };
    expect(listBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: OWNER, email: "owner@example.test", role: "owner" }),
        expect.objectContaining({ id: NEW_MEMBER, email: "new@example.test", role: "member" }),
      ]),
    );

    const removed = await memberResource.$delete({
      param: { orgId: PRIMARY.orgId, userId: NEW_MEMBER },
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
  });

  it("403s a member-role token attempting Org patch or member add", async () => {
    const memberJwt = await token(MEMBER, PRIMARY.orgId, "member");
    const api = client(memberJwt);

    const patchOrg = await orgRoute(api).$patch({
      param: { orgId: PRIMARY.orgId },
      json: { name: "Nope" },
    });
    expect(patchOrg.status).toBe(403);
    expect((await bodyOf(patchOrg)).code).toBe("FORBIDDEN");

    const addMember = await memberRoute(api).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "member" },
    });
    expect(addMember.status).toBe(403);
    expect((await bodyOf(addMember)).code).toBe("FORBIDDEN");
  });

  it("403s an admin-role token granting the owner role (owner grants are owner-only)", async () => {
    const adminJwt = await token(ADMIN, PRIMARY.orgId, "admin");
    const res = await memberRoute(client(adminJwt)).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "owner" },
    });

    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("lets an owner-role token grant the owner role", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const res = await memberRoute(client(ownerJwt)).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "owner" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: NEW_MEMBER, role: "owner" });
  });

  it("does not let member add change an existing member role", async () => {
    const adminJwt = await token(ADMIN, PRIMARY.orgId, "admin");
    const res = await memberRoute(client(adminJwt)).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: OWNER, role: "member" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: OWNER, role: "owner" });
  });

  it("409s LAST_OWNER_REQUIRED when removing or demoting the last owner", async () => {
    const ownerJwt = await token(SOLO_OWNER, SOLO.orgId, "owner");
    const resource = memberResourceRoute(client(ownerJwt));

    const demote = await resource.$patch({
      param: { orgId: SOLO.orgId, userId: SOLO_OWNER },
      json: { role: "member" },
    });
    expect(demote.status).toBe(409);
    expect((await bodyOf(demote)).code).toBe("LAST_OWNER_REQUIRED");

    const res = await resource.$delete({
      param: { orgId: SOLO.orgId, userId: SOLO_OWNER },
    });

    expect(res.status).toBe(409);
    const err = await bodyOf(res);
    expect(err.code).toBe("LAST_OWNER_REQUIRED");
    if (err.code === "LAST_OWNER_REQUIRED") {
      expect(err.details.orgId).toBe(SOLO.orgId);
    }
  });

  it("derives matching MCP tools for the mounted Organization operations", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const getOrg = await orgRoute(client(ownerJwt)).$get({
      param: { orgId: PRIMARY.orgId },
    });
    expect(getOrg.status).toBe(200);

    const expected = [
      "organizations_get",
      "organizations_update",
      "organization_members_list",
      "organization_members_add",
      "organization_members_update",
      "organization_members_remove",
    ] as const;
    const tools = deriveMcpTools();

    for (const operationId of expected) {
      const route = getRoute(operationId);
      const tool = tools.find((candidate) => candidate.name === operationId);
      expect(tool).toBeDefined();
      expect(route).toBeDefined();
      expect(tool?.outputSchema).toBe(route?.output);
    }
  });
});
