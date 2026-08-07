import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrgMemberList, OrgMembersView } from "#lib/org-members";
import type { OrgRole } from "#lib/session";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: () => {} }),
  useRouterState: () => "/",
}));
vi.mock("#lib/control-plane-org-member-functions", () => ({
  addControlPanelOrgMember: vi.fn(),
  removeControlPanelOrgMember: vi.fn(),
  updateControlPanelOrgMemberRole: vi.fn(),
}));

const { OrgMembersPage } = await import("./org-members-page");

const members: OrgMemberList = {
  kind: "ready",
  items: [
    { userId: "u_owner", email: "owner@acme.test", role: "owner" },
    { userId: "u_admin", email: "admin@acme.test", role: "admin" },
    { userId: "u_member", email: "member@acme.test", role: "member" },
  ],
};

function page(orgRole: OrgRole, list: OrgMemberList = members, userId = "u_owner") {
  const view: OrgMembersView = {
    orgId: "org_acme",
    orgSlug: "acme-labs",
    orgRole,
    userId,
    members: list,
  };
  return renderToStaticMarkup(<OrgMembersPage view={view} />);
}

describe("Members screen role matrix", () => {
  it("gives an owner the add affordance and per-member controls", () => {
    const html = page("owner");

    expect(html).toContain('data-testid="add-member"');
    expect(html).not.toContain('data-testid="add-member-locked"');
    expect(html).toContain('data-testid="member-role-u_admin"');
    expect(html).toContain('data-testid="member-remove-u_admin"');
  });

  it("gives an admin the add affordance but locks role changes and removal", () => {
    const html = page("admin");

    expect(html).toContain('data-testid="add-member"');
    expect(html).toContain('data-testid="member-actions-locked-u_admin"');
    expect(html).not.toContain('data-testid="member-remove-u_admin"');
  });

  it("locks the add affordance for a member instead of hiding it", () => {
    const html = page("member", { kind: "locked", message: "Only owners and admins can view." });

    expect(html).toContain('data-testid="add-member-locked"');
    expect(html).not.toContain('data-testid="add-member"');
  });

  it("tells a member why the list is absent rather than showing an empty table", () => {
    const html = page("member", { kind: "locked", message: "Only owners and admins can view." });

    expect(html).toContain('data-testid="members-locked"');
    expect(html).toContain("Only owners and admins can view.");
    expect(html).not.toContain("<table");
  });

  it("reports a failed read as unavailable, never as an empty Organization", () => {
    const html = page("owner", {
      kind: "unavailable",
      message: "member profile is not configured",
    });

    expect(html).toContain('data-testid="members-unavailable"');
    expect(html).toContain("member profile is not configured");
    expect(html).not.toContain("<table");
  });
});

describe("last-owner guard", () => {
  it("locks the sole owner's own controls and says why", () => {
    const html = page("owner", {
      kind: "ready",
      items: [
        { userId: "u_owner", email: "owner@acme.test", role: "owner" },
        { userId: "u_admin", email: "admin@acme.test", role: "admin" },
      ],
    });

    expect(html).toContain("The only owner. Promote another member to owner first.");
    // Anchored on the attribute, not on the class list: every Button ships a
    // `disabled:` utility class, so a loose match is green either way.
    expect(html).toMatch(/disabled=""[^>]*data-testid="member-remove-u_owner"/);
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="member-remove-u_admin"/);
    expect(html).toMatch(/disabled=""[^>]*data-testid="member-role-u_owner"/);
  });

  it("releases the guard once a second owner exists", () => {
    const html = page("owner", {
      kind: "ready",
      items: [
        { userId: "u_owner", email: "owner@acme.test", role: "owner" },
        { userId: "u_second", email: "second@acme.test", role: "owner" },
      ],
    });

    expect(html).not.toContain("The only owner. Promote another member to owner first.");
  });
});

describe("SSO and SCIM affordances", () => {
  it("offers configuration to owner and admin", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(page(role)).toContain("Contact your account team");
    }
  });

  it("locks trusted identity providers for an admin", () => {
    const html = page("admin");

    expect(html).toContain("Requires an Organization owner. Your role is admin.");
  });

  it("locks both rows for a member", () => {
    const html = page("member", { kind: "locked", message: "locked" });

    expect(html).toContain("Requires an Organization owner or admin. Your role is member.");
    expect(html).toContain("Requires an Organization owner. Your role is member.");
  });
});
