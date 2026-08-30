import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrgRole } from "#lib/sessions/session";

vi.mock("#lib/integrations/control-plane-sentry-functions", () => ({
  loadControlPanelSentryInstallations: vi.fn(),
  installControlPanelSentry: vi.fn(),
  rotateControlPanelSentrySecret: vi.fn(),
  revokeControlPanelSentryInstallation: vi.fn(),
}));

const { OrgIntegrationsPage } = await import("#components/integrations/org-integrations-page");

describe("OrgIntegrationsPage", () => {
  it("offers Sentry to an Organization admin", () => {
    const html = render("admin");
    expect(html).toContain("Sentry change tracking");
    expect(html).toContain("across all Apps and Environments");
  });

  it("names the role a member is missing instead of showing a connector they cannot use", () => {
    const html = render("member");
    expect(html).toContain("Only owners and admins can manage Organization integrations.");
    expect(html).not.toContain("Sentry change tracking");
  });

  it("teaches the same operation in the terminal and to an agent", () => {
    expect(render("owner")).toContain("sentry_installations_list");
  });
});

function render(orgRole: OrgRole): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <OrgIntegrationsPage orgId="org_1" orgRole={orgRole} />
    </QueryClientProvider>,
  );
}
