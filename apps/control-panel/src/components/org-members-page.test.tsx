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
const { ADD_MEMBER_USER_ID_HELP, addMemberErrorMessage } = await import("./add-org-member-form");

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
    expect(html).toMatch(/data-slot="select-value"[^>]*>Admin<\/span>/u);
  });

  it("gives an admin the add affordance but locks role changes and removal", () => {
    const html = page("admin");

    expect(html).toContain('data-testid="add-member"');
    expect(html).toContain("Changing roles and removing members requires the Owner role.");
    expect(html).not.toContain('data-testid="member-remove-u_admin"');
  });

  it("renders the add restriction as visible text instead of a disabled control", () => {
    const html = page("member", { kind: "locked", message: "Only owners and admins can view." });

    expect(html).toContain('data-testid="add-member-locked"');
    expect(html).toContain("Adding a member requires the Owner or Admin role.");
    expect(html).not.toContain('data-testid="add-member"');
    expect(html).not.toContain("Add member (locked)");
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

  it("renders a membership without profile data and says why the email is absent", () => {
    const html = page("owner", {
      kind: "ready",
      items: [{ userId: "u_new", email: null, role: "member" }],
    });

    expect(html).toContain('data-member-id="u_new"');
    expect(html).toContain("Email unavailable");
    expect(html).not.toContain("u_new</code>");
    expect(html).not.toContain("unknown@");
  });
});

describe("Add member errors", () => {
  it("points to the screen that actually shows the signed-in User ID", () => {
    expect(ADD_MEMBER_USER_ID_HELP).toBe(
      "Shown on the Control Panel home screen after “Signed in as”.",
    );
    expect(ADD_MEMBER_USER_ID_HELP).not.toContain("user menu");
  });

  it("explains an existing membership without exposing the raw role value", () => {
    expect(
      addMemberErrorMessage({
        code: "MEMBERSHIP_CONFLICT",
        message: "user is already an organization member",
        details: { existingRole: "admin" },
      }),
    ).toBe(
      "This person is already a member with the Admin role. Change their role from the member row.",
    );
  });
});

describe("last-owner guard", () => {
  it("omits the sole owner's own controls and says why", () => {
    const html = page("owner", {
      kind: "ready",
      items: [
        { userId: "u_owner", email: "owner@acme.test", role: "owner" },
        { userId: "u_admin", email: "admin@acme.test", role: "admin" },
      ],
    });

    expect(html).toContain("The only owner. Promote another member to owner first.");
    expect(html).toContain('data-testid="member-actions-sole-owner-u_owner"');
    expect(html).not.toContain('data-testid="member-remove-u_owner"');
    expect(html).not.toContain('data-testid="member-role-u_owner"');
    expect(html).toContain('data-testid="member-remove-u_admin"');
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
      expect(page(role)).toContain("Available");
    }
  });

  it("locks trusted identity providers for an admin", () => {
    const html = page("admin");

    expect(html).toContain("Requires an Organization owner. Your role is Admin.");
  });

  it("locks both rows for a member", () => {
    const html = page("member", { kind: "locked", message: "locked" });

    expect(html).toContain("Requires an Organization owner or admin. Your role is Member.");
    expect(html).toContain("Requires an Organization owner. Your role is Member.");
  });
});
