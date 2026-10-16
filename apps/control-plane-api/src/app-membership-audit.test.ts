import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_APP,
  AUDIT_ORG,
  CANARIES,
  CANDIDATE,
  type CredentialMembershipAuditFixture,
  MEMBER,
  makeCredentialMembershipAuditFixture,
  membershipPath,
  OTHER_APP,
  OWNER,
} from "./credential-membership-audit-fixture";

let fixture: CredentialMembershipAuditFixture;
beforeEach(async () => {
  fixture = await makeCredentialMembershipAuditFixture();
});
afterEach(async () => {
  await fixture?.dispose();
});

describe("App membership audit producers through the real route stack and D1", () => {
  it("audits add, update and remove exactly once, with no events for recognized retries", async () => {
    const add = () =>
      fixture.request("POST", membershipPath(), { userId: CANDIDATE, role: "member" });
    expect((await add()).status).toBe(200);
    expect(await fixture.events()).toHaveLength(1);
    expect((await add()).status).toBe(409);
    expect(await fixture.events()).toHaveLength(1);
    const update = () => fixture.request("PATCH", membershipPath(CANDIDATE), { role: "admin" });
    expect((await update()).status).toBe(200);
    expect(await fixture.events()).toHaveLength(2);
    expect((await update()).status).toBe(200);
    expect(await fixture.events()).toHaveLength(2);
    expect(
      await fixture.repo.identity.getAppMembership(appScope(AUDIT_APP), CANDIDATE),
    ).toMatchObject({ role: "admin" });
    expect((await fixture.request("DELETE", membershipPath(CANDIDATE))).status).toBe(200);
    expect(await fixture.events()).toHaveLength(3);
    expect((await fixture.request("DELETE", membershipPath(CANDIDATE))).status).toBe(404);
    expect(await fixture.events()).toHaveLength(3);
    expect(await fixture.repo.identity.getAppMembership(appScope(AUDIT_APP), CANDIDATE)).toBeNull();
    const events = await fixture.events();
    expect(events.map((row) => row.action)).toEqual([
      "app_members_add",
      "app_members_update",
      "app_members_remove",
    ]);
    expect(new Set(events.map((row) => row.eventId)).size).toBe(3);
    for (const event of events) {
      expect(event).toMatchObject({
        appId: AUDIT_APP,
        organizationId: AUDIT_ORG,
        environmentId: null,
        resourceType: "app_membership",
        resourceId: CANDIDATE,
      });
    }
    expect(events.map((row) => JSON.parse(row.changesJson))).toEqual([
      { role: "member" },
      { role: "admin" },
      {},
    ]);
    await fixture.expectSafeEvents();
  });

  it("keeps the same user's memberships and audit history isolated across Apps", async () => {
    const otherBefore = await fixture.repo.identity.listAppMembers(appScope(OTHER_APP));
    expect((await fixture.request("PATCH", membershipPath(MEMBER), { role: "admin" })).status).toBe(
      200,
    );
    expect((await fixture.request("DELETE", membershipPath(MEMBER))).status).toBe(200);
    expect(await fixture.repo.identity.listAppMembers(appScope(OTHER_APP))).toEqual(otherBefore);
    expect(await fixture.events(OTHER_APP)).toEqual([]);
    expect((await fixture.events()).map((row) => row.resourceId)).toEqual([MEMBER, MEMBER]);
    expect(
      (
        await fixture.request("POST", membershipPath(undefined, OTHER_APP), {
          userId: CANDIDATE,
          role: "member",
        })
      ).status,
    ).toBe(403);
    expect(
      (await fixture.request("PATCH", membershipPath(MEMBER, OTHER_APP), { role: "member" }))
        .status,
    ).toBe(403);
    expect((await fixture.request("DELETE", membershipPath(MEMBER, OTHER_APP))).status).toBe(403);
    expect(await fixture.events()).toHaveLength(2);
    expect(await fixture.events(OTHER_APP)).toEqual([]);
  });

  it("does not audit malformed, unauthorized, missing, same-role or last-owner no-writes", async () => {
    const memberApp = fixture.appFor({ id: MEMBER });
    for (const [method, userId, body, status] of [
      ["POST", undefined, { userId: CANDIDATE, role: "invalid" }, 400],
      ["POST", undefined, { userId: "user_outside_org", role: "member" }, 404],
      [
        "POST",
        undefined,
        { userId: CANDIDATE, role: "member", actorRef: CANARIES.actor, context: CANARIES.context },
        400,
      ],
      ["PATCH", MEMBER, { role: "invalid" }, 400],
      ["PATCH", MEMBER, { role: "member", targetingKey: CANARIES.targetingKey }, 400],
      ["PATCH", "user_missing", { role: "member" }, 404],
      ["DELETE", "user_missing", undefined, 404],
      ["PATCH", MEMBER, { role: "member" }, 200],
      ["PATCH", OWNER, { role: "admin" }, 409],
      ["DELETE", OWNER, undefined, 409],
    ] as const) {
      expect((await fixture.request(method, membershipPath(userId), body)).status).toBe(status);
      expect(await fixture.events()).toEqual([]);
    }
    for (const [method, path, body] of [
      ["POST", membershipPath(), { userId: CANDIDATE, role: "member" }],
      ["PATCH", membershipPath(MEMBER), { role: "admin" }],
      ["DELETE", membershipPath(MEMBER), undefined],
    ] as const) {
      expect((await fixture.request(method, path, body, memberApp)).status).toBe(403);
    }
    expect(await fixture.events()).toEqual([]);
    expect(await fixture.repo.identity.getAppMembership(appScope(AUDIT_APP), OWNER)).toMatchObject({
      role: "owner",
    });
  });

  it.each([
    ["add", "POST", undefined, { userId: CANDIDATE, role: "member" }],
    ["update", "PATCH", MEMBER, { role: "admin" }],
    ["remove", "DELETE", MEMBER, undefined],
  ] as const)(
    "rolls back membership %s when the audit INSERT fails in real D1",
    async (_name, method, userId, body) => {
      const before = await fixture.repo.identity.listAppMembers(appScope(AUDIT_APP));
      await fixture.failAuditInsert();
      expect((await fixture.request(method, membershipPath(userId), body)).status).toBe(500);
      expect(fixture.faults).toEqual([{ auditInsertRejected: true }]);
      expect(await fixture.repo.identity.listAppMembers(appScope(AUDIT_APP))).toEqual(before);
      expect(await fixture.events()).toEqual([]);
    },
  );
});
