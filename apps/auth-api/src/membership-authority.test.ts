import { describe, expect, it } from "vitest";
import {
  type MembershipAuthorityRepo,
  narrowMembershipAuthority,
  parseRequestedScopes,
  resolveMembershipAuthority,
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
