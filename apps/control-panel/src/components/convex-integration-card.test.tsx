import type { ConvexInstallationStatus } from "@splitch/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "#lib/query-keys";

vi.mock("#lib/control-plane-convex-functions", () => ({
  loadControlPanelConvexInstallations: vi.fn(),
  revokeControlPanelConvexInstallation: vi.fn(),
}));

const { ConvexIntegrationCard } = await import("./convex-integration-card");

const APP_ID = "app_1";
const ENVIRONMENT_ID = "env_1";

describe("ConvexIntegrationCard", () => {
  it("shows neither setup steps nor the table while the list is loading", () => {
    const html = render(new QueryClient());
    expect(html).toContain("Loading Convex status");
    expect(html).not.toContain('data-testid="convex-setup-steps"');
    expect(html).not.toContain("<table");
  });

  it("shows component setup once the list settles empty", () => {
    const html = render(seeded([]));
    expect(html).toContain("npm install @splitch/convex");
    expect(html).toContain("SPLITCH_API_KEY");
    expect(html).toContain("flags.install(ctx)");
  });

  it("shows an active installation and hides component setup", () => {
    const html = render(seeded([installation({ status: "active" })]));
    expect(html).toContain("data-convex-installation-id");
    expect(html).toContain("<table");
    expect(html).not.toContain('data-testid="convex-setup-steps"');
  });

  it("shows setup alongside a revoked row with Disconnect disabled", () => {
    const html = render(seeded([installation({ status: "revoked" })]));
    expect(html).toContain('data-testid="convex-setup-steps"');
    expect(html).toContain("data-convex-installation-id");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Disconnect<\/button>/);
  });
});

function render(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ConvexIntegrationCard appId={APP_ID} environmentId={ENVIRONMENT_ID} />
    </QueryClientProvider>,
  );
}

function seeded(installations: ConvexInstallationStatus[]): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    queryKeys.environment.convexInstallations(APP_ID, ENVIRONMENT_ID),
    installations,
  );
  return queryClient;
}

function installation(overrides: Partial<ConvexInstallationStatus>): ConvexInstallationStatus {
  return {
    installationId: "11111111-1111-4111-8111-111111111111",
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    callbackUrl: "https://customer.convex.site/integrations/splitch/configuration",
    environmentVersion: 43,
    status: "active",
    lastDeliveredVersion: 41,
    lastDeliveredAt: "2026-08-26T00:00:00.000Z",
    pendingCount: 1,
    oldestPendingAgeMs: 60_000,
    terminalCount: 0,
    latestDeliveryError: null,
    ...overrides,
  };
}
