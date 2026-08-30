import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The chooser reaches the create server function through the dialog; the
// durable-notice wiring under test has nothing to do with it.
vi.mock("#lib/organizations/control-plane-organization-functions", () => ({
  createControlPanelOrganization: vi.fn(),
}));

const { OrganizationChooser } = await import("#components/organizations/organization-chooser");

/**
 * Proves the durable half of the notice (SPL-203 review round 2, Blocker 2 /
 * also-fix): a marker read on the server and passed in as `pendingResync`
 * must reach `StaleSessionNotice`, not just the local `onStaleSession` state
 * that resets on every reload.
 */
describe("OrganizationChooser durable stale-session notice", () => {
  it("renders the notice from a durably pending marker with no local state involved", () => {
    const html = renderToStaticMarkup(
      <OrganizationChooser
        orgs={[membership()]}
        pendingResync={{ slug: "kiln-works", reason: "KV outage", remedy: "retry" }}
      />,
    );

    expect(html).toContain('data-testid="organization-session-stale"');
    expect(html).toContain("kiln-works");
    expect(html).toContain("KV outage");
  });

  it("stays silent when nothing is pending", () => {
    const html = renderToStaticMarkup(
      <OrganizationChooser orgs={[membership()]} pendingResync={null} />,
    );

    expect(html).not.toContain('data-testid="organization-session-stale"');
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
