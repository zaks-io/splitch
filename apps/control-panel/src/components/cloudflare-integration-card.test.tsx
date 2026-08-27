import type { CloudflareInstallationStatus } from "@splitch/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "#lib/query-keys";

vi.mock("#lib/control-plane-cloudflare-functions", () => ({
  loadControlPanelCloudflareInstallations: vi.fn(),
  revokeControlPanelCloudflareInstallation: vi.fn(),
}));

const { CloudflareIntegrationCard } = await import("./cloudflare-integration-card");

const APP_ID = "app_1";
const ENVIRONMENT_ID = "env_1";
const ENVIRONMENT_KEY = "production";

describe("CloudflareIntegrationCard", () => {
  it("shows neither setup steps nor the table while the list is loading", () => {
    const html = render(new QueryClient());
    expect(html).toContain("Loading Cloudflare status");
    expect(html).not.toContain('data-testid="cloudflare-setup-steps"');
    expect(html).not.toContain("<table");
  });

  it("shows CLI setup once the list settles empty", () => {
    const html = render(seeded([]));
    expect(html).toContain("splitch cloudflare setup --env production");
    expect(html).toContain("Wrangler 4");
    expect(html).toContain("project directory");
  });

  it("shows an active installation and hides CLI setup", () => {
    const html = render(seeded([installation({ status: "active" })]));
    expect(html).toContain("data-cloudflare-installation-id");
    expect(html).toContain("<table");
    expect(html).not.toContain('data-testid="cloudflare-setup-steps"');
  });

  it("shows setup alongside a revoked row with Disconnect disabled", () => {
    const html = render(seeded([installation({ status: "revoked" })]));
    expect(html).toContain('data-testid="cloudflare-setup-steps"');
    expect(html).toContain("data-cloudflare-installation-id");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Disconnect<\/button>/);
  });
});

function render(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <CloudflareIntegrationCard
        appId={APP_ID}
        environmentId={ENVIRONMENT_ID}
        environmentKey={ENVIRONMENT_KEY}
      />
    </QueryClientProvider>,
  );
}

function seeded(installations: CloudflareInstallationStatus[]): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    queryKeys.environment.cloudflareInstallations(APP_ID, ENVIRONMENT_ID),
    installations,
  );
  return queryClient;
}

function installation(
  overrides: Partial<CloudflareInstallationStatus>,
): CloudflareInstallationStatus {
  return {
    installationId: "22222222-2222-4222-8222-222222222222",
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    endpoint: "https://splitch-config.customer.workers.dev/integrations/splitch/configuration",
    environmentVersion: 43,
    status: "active",
    lastAppliedVersion: 41,
    lastAppliedAt: "2026-08-26T00:00:00.000Z",
    pendingCount: 1,
    oldestPendingAgeMs: 60_000,
    terminalCount: 0,
    latestDeliveryError: null,
    ...overrides,
  };
}
