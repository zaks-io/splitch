import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_CACHE_TTL_SECONDS,
  MembershipSetSchema,
  membershipCacheKey,
} from "./membership-set";

describe("MembershipSetSchema", () => {
  it("accepts the complete Organization and App membership shape", () => {
    expect(
      MembershipSetSchema.parse({
        organizations: [{ id: "org_1", role: "admin" }],
        apps: [{ id: "app_1", organizationId: "org_1", role: "member" }],
      }),
    ).toEqual({
      organizations: [{ id: "org_1", role: "admin" }],
      apps: [{ id: "app_1", organizationId: "org_1", role: "member" }],
    });
  });

  it("rejects an App membership without its owning Organization membership", () => {
    expect(
      MembershipSetSchema.safeParse({
        organizations: [],
        apps: [{ id: "app_1", organizationId: "org_1", role: "member" }],
      }).success,
    ).toBe(false);
  });

  it("pins the shortest Workers KV TTL and key namespace", () => {
    expect(MEMBERSHIP_CACHE_TTL_SECONDS).toBe(60);
    expect(membershipCacheKey("user_1")).toBe("memberships:user_1");
  });
});
