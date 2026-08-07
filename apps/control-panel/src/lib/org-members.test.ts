import { describe, expect, it } from "vitest";
import {
  assignableRoles,
  canAddOrgMember,
  canChangeOrgMemberRole,
  canConfigureSso,
  canGrantOrgRole,
  canManageTrustedIdps,
  canRemoveOrgMember,
  canViewOrgMembers,
  isLastOwner,
  type OrgMember,
} from "./org-members";

const ROLES = ["owner", "admin", "member"] as const;

/**
 * The gates are pinned against the Control Plane's own membership gates
 * (`org-handlers.ts` + `mcp-tool-membership-gates.ts`), not against the prose
 * matrix, which currently reads looser than the shipped Worker. If the Worker
 * moves, this table is where the Panel's copy has to move with it.
 */
describe("Org membership gates mirror the Control Plane", () => {
  it("lists and adds at owner+admin", () => {
    expect(ROLES.map(canViewOrgMembers)).toEqual([true, true, false]);
    expect(ROLES.map(canAddOrgMember)).toEqual([true, true, false]);
  });

  it("changes roles and removes at owner only", () => {
    expect(ROLES.map(canChangeOrgMemberRole)).toEqual([true, false, false]);
    expect(ROLES.map(canRemoveOrgMember)).toEqual([true, false, false]);
  });

  it("lets an admin add a member but never mint an owner", () => {
    expect(canGrantOrgRole("admin", "member")).toBe(true);
    expect(canGrantOrgRole("admin", "admin")).toBe(true);
    expect(canGrantOrgRole("admin", "owner")).toBe(false);
    expect(canGrantOrgRole("owner", "owner")).toBe(true);
    expect(canGrantOrgRole("member", "member")).toBe(false);
  });

  it("offers exactly the roles the actor may grant", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "member"]);
    expect(assignableRoles("admin")).toEqual(["admin", "member"]);
    for (const role of assignableRoles("admin")) {
      expect(canGrantOrgRole("admin", role)).toBe(true);
    }
  });

  it("gates SSO/SCIM at owner+admin and trusted IdPs at owner", () => {
    expect(ROLES.map(canConfigureSso)).toEqual([true, true, false]);
    expect(ROLES.map(canManageTrustedIdps)).toEqual([true, false, false]);
  });
});

describe("sole-owner detection", () => {
  const owner: OrgMember = { userId: "u_owner", email: "owner@acme.test", role: "owner" };
  const admin: OrgMember = { userId: "u_admin", email: "admin@acme.test", role: "admin" };
  const second: OrgMember = { userId: "u_second", email: "second@acme.test", role: "owner" };

  it("names the only owner, and only them", () => {
    expect(isLastOwner([owner, admin], "u_owner")).toBe(true);
    expect(isLastOwner([owner, admin], "u_admin")).toBe(false);
  });

  it("stops naming anyone once a second owner exists", () => {
    expect(isLastOwner([owner, second, admin], "u_owner")).toBe(false);
    expect(isLastOwner([owner, second, admin], "u_second")).toBe(false);
  });

  it("names nobody when the list carries no owner at all", () => {
    expect(isLastOwner([admin], "u_admin")).toBe(false);
  });
});
