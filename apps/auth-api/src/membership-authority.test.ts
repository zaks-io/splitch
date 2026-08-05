import { describe, expect, it } from "vitest";
import {
  type MembershipAuthorityRepo,
  narrowMembershipAuthority,
  parseRequestedScopes,
  resolveAppSelectionForUser,
  resolveMembershipAuthority,
  resolveOrgSelectionForUser,
} from "./membership-authority";

const USER = "user_device";
const SELECTED_APP = "app_selected";
const VICTIM_APP = "app_victim";

describe("device membership authority", () => {
  it("intersects caller-requested scopes with live D1 Organization and App memberships", async () => {
    const repo = {
      identity: {
        listOrgMembershipsForUser: async () => [{ orgId: "org_selected", role: "owner" }],
        listAppsForOrg: async () => [{ id: SELECTED_APP }, { id: VICTIM_APP }],
        getAppMembership: async (scope: { appId: string }) =>
          scope.appId === SELECTED_APP ? { role: "admin" } : null,
      },
    } as unknown as MembershipAuthorityRepo;

    const authority = await resolveMembershipAuthority(repo, USER);
    expect(authority).toEqual([`app:${SELECTED_APP}:admin`, "org:org_selected:owner"]);

    expect(
      narrowMembershipAuthority(
        authority,
        parseRequestedScopes(`app:${SELECTED_APP}:admin app:${VICTIM_APP}:admin`),
      ),
    ).toEqual([`app:${SELECTED_APP}:admin`]);
  });

  it("applies both provider and token-request scope constraints without widening either", () => {
    const authority = [`app:${SELECTED_APP}:owner`, "org:org_selected:owner"];

    expect(
      narrowMembershipAuthority(
        authority,
        [`app:${SELECTED_APP}:admin`],
        [`app:${SELECTED_APP}:member`],
      ),
    ).toEqual([`app:${SELECTED_APP}:member`]);

    expect(
      narrowMembershipAuthority(
        authority,
        [`app:${SELECTED_APP}:admin`],
        [`app:${VICTIM_APP}:admin`],
      ),
    ).toEqual([]);
  });
});

/**
 * CLI allow-list in apps/cli/src/auth-binding.ts matches these four
 * error_description literals. Rewording any of them silently remaps live-session
 * binding refusals to CLI_SESSION_EXPIRED — pin them here so that break fails loud.
 */
describe("refresh-binding invalid_grant prose (CLI allow-list contract)", () => {
  it("refuses a reachable App the user is not a member of with the authorized literal", async () => {
    const repo = {
      identity: {
        listOrgMembershipsForUser: async () => [{ orgId: "org_1", role: "owner" }],
        listAppsForOrg: async () => [{ id: SELECTED_APP, key: "checkout" }],
        getAppMembership: async () => null,
      },
    } as unknown as MembershipAuthorityRepo;

    await expect(resolveAppSelectionForUser(repo, USER, SELECTED_APP)).rejects.toMatchObject({
      code: "invalid_grant",
      message: "selected App is not authorized by live membership",
    });
  });

  it("refuses an unreachable App selector with the reachable literal", async () => {
    const repo = {
      identity: {
        listOrgMembershipsForUser: async () => [{ orgId: "org_1", role: "owner" }],
        listAppsForOrg: async () => [{ id: SELECTED_APP, key: "checkout" }],
        getAppMembership: async () => ({ role: "admin" }),
      },
    } as unknown as MembershipAuthorityRepo;

    await expect(resolveAppSelectionForUser(repo, USER, "missing-app")).rejects.toMatchObject({
      code: "invalid_grant",
      message: "selected App is not reachable by live membership",
    });
  });

  it("refuses an ambiguous App key with the matches-more-than-one literal", async () => {
    const repo = {
      identity: {
        listOrgMembershipsForUser: async () => [
          { orgId: "org_a", role: "owner" },
          { orgId: "org_b", role: "owner" },
        ],
        listAppsForOrg: async (orgId: string) =>
          orgId === "org_a"
            ? [{ id: "app_a", key: "checkout" }]
            : [{ id: "app_b", key: "checkout" }],
        getAppMembership: async () => ({ role: "admin" }),
      },
    } as unknown as MembershipAuthorityRepo;

    await expect(resolveAppSelectionForUser(repo, USER, "checkout")).rejects.toMatchObject({
      code: "invalid_grant",
      message:
        'App selector "checkout" matches more than one App across your Organizations; pass the canonical App ID',
    });
  });

  it("refuses an unreachable Organization with the org reachable literal", async () => {
    const repo = {
      identity: {
        listOrgMembershipsForUser: async () => [{ orgId: "org_1", role: "owner" }],
        getOrg: async () => ({ id: "org_1", slug: "acme" }),
      },
    } as unknown as MembershipAuthorityRepo;

    await expect(resolveOrgSelectionForUser(repo, USER, "missing-org")).rejects.toMatchObject({
      code: "invalid_grant",
      message: "selected Organization is not reachable by live membership",
    });
  });
});
