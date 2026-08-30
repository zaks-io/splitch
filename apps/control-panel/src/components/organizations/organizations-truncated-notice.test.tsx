import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrganizationsTruncatedNotice } from "#components/organizations/organizations-truncated-notice";

// The chooser reaches the create server function through the dialog; the notice
// under test has nothing to do with it.
vi.mock("#lib/organizations/control-plane-organization-functions", () => ({
  createControlPanelOrganization: vi.fn(),
}));

const { OrganizationChooser } = await import("#components/organizations/organization-chooser");

describe("OrganizationsTruncatedNotice", () => {
  it("names the bound and offers an uncapped surface rather than an impossible retry", () => {
    const html = renderToStaticMarkup(<OrganizationsTruncatedNotice limit={50} />);

    expect(html).toContain('data-testid="organizations-truncated"');
    expect(html).toContain("Showing the first 50 of your Organizations");
    expect(html).toContain("nothing was deleted");
    // Every Panel route authorizes against the same capped snapshot, so a URL
    // would be a retry that cannot succeed. The remedy has to leave the Panel.
    expect(html).toContain("splitch orgs list");
    expect(html).not.toContain("href=");
  });
});

describe("OrganizationChooser truncation", () => {
  it("says the list is cut short when the snapshot was capped", () => {
    const html = renderToStaticMarkup(<OrganizationChooser orgs={[membership()]} truncated />);

    expect(html).toContain('data-testid="organizations-truncated"');
  });

  it("stays silent when the snapshot holds every Organization", () => {
    const html = renderToStaticMarkup(<OrganizationChooser orgs={[membership()]} />);

    expect(html).not.toContain('data-testid="organizations-truncated"');
  });
});

function membership() {
  return {
    apps: [],
    demoExpiresAt: null,
    isProvisional: false,
    orgId: "org_1",
    orgRole: "owner" as const,
    orgSlug: "acme-labs",
  };
}
