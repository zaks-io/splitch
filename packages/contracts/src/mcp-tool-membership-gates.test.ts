import { describe, expect, it } from "vitest";
import {
  getRouteMembershipGate,
  membershipGatePatterns,
  scopeSatisfiesMembershipGate,
} from "./mcp-tool-membership-gates";

describe("mcp tool membership gates", () => {
  it("requires org owner for organizations_update, not org admin", () => {
    const gate = membershipGatePatterns(getRouteMembershipGate("organizations_update"));
    expect(gate).toEqual(["org:owner"]);
    expect(scopeSatisfiesMembershipGate("org:org_local:admin", gate[0] as string)).toBe(false);
    expect(scopeSatisfiesMembershipGate("org:org_local:owner", gate[0] as string)).toBe(true);
  });

  it("requires org admin for organization_members_list, not org member", () => {
    const gate = membershipGatePatterns(getRouteMembershipGate("organization_members_list"));
    expect(gate).toEqual(["org:admin"]);
    expect(scopeSatisfiesMembershipGate("org:org_local:member", gate[0] as string)).toBe(false);
    expect(scopeSatisfiesMembershipGate("org:org_local:admin", gate[0] as string)).toBe(true);
    expect(scopeSatisfiesMembershipGate("org:org_local:owner", gate[0] as string)).toBe(true);
  });

  it("requires app owner for app deletes while writes stop at app admin", () => {
    const deleteGate = membershipGatePatterns(getRouteMembershipGate("apps_delete"));
    const updateGate = membershipGatePatterns(getRouteMembershipGate("apps_update"));
    expect(deleteGate).toEqual(["app:owner"]);
    expect(updateGate).toEqual(["app:admin"]);
    expect(scopeSatisfiesMembershipGate("app:app_local:admin", deleteGate[0] as string)).toBe(
      false,
    );
    expect(scopeSatisfiesMembershipGate("app:app_local:admin", updateGate[0] as string)).toBe(true);
    expect(scopeSatisfiesMembershipGate("app:app_local:owner", deleteGate[0] as string)).toBe(true);
  });
});
