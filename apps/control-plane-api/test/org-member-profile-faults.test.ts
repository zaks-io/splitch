import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  client,
  memberResourceRoute,
  memberRoute,
  OWNER,
  PRIMARY,
  PROFILELESS_MEMBER,
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

describe("control-plane org/member profile-resolution faults", () => {
  it("fails loud when a profile lookup faults, without naming the member", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const api = client(ownerJwt, { "x-test-profile-failure-user": PROFILELESS_MEMBER });
    const res = await memberRoute(api).$get({ param: { orgId: PRIMARY.orgId } });

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "member profile lookup failed",
    });
    // The Panel renders this message verbatim, and the Members screen shows
    // emails rather than splitch User IDs. The faulting member's ID belongs in
    // the log, not in another person's browser.
    expect(body).not.toContain(PROFILELESS_MEMBER);
  });

  it("fails loud before adding when the profile lookup faults", async () => {
    const ownerJwt = await token(SOLO_OWNER, SOLO.orgId, "owner");
    const api = client(ownerJwt, { "x-test-profile-failure-user": PROFILELESS_MEMBER });
    const res = await memberRoute(api).$post({
      param: { orgId: SOLO.orgId },
      json: { userId: PROFILELESS_MEMBER, role: "member" },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "member profile lookup failed",
    });

    const roster = await memberRoute(client(ownerJwt)).$get({ param: { orgId: SOLO.orgId } });
    expect(roster.status).toBe(200);
    expect((await roster.json()).items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PROFILELESS_MEMBER })]),
    );
  });

  it("fails loud before writing when the profile lookup faults on update, leaving the role unchanged", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const api = client(ownerJwt, { "x-test-profile-failure-user": PROFILELESS_MEMBER });
    const res = await memberResourceRoute(api).$patch({
      param: { orgId: PRIMARY.orgId, userId: PROFILELESS_MEMBER },
      json: { role: "admin" },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "member profile lookup failed",
    });

    const roster = await memberRoute(client(ownerJwt)).$get({ param: { orgId: PRIMARY.orgId } });
    expect(roster.status).toBe(200);
    expect((await roster.json()).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PROFILELESS_MEMBER, role: "member" })]),
    );
  });
});
