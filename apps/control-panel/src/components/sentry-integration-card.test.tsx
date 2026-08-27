import type { SentryInstallationStatus } from "@splitch/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "#lib/query-keys";

vi.mock("#lib/control-plane-sentry-functions", () => ({
  loadControlPanelSentryInstallations: vi.fn(),
  installControlPanelSentry: vi.fn(),
  rotateControlPanelSentrySecret: vi.fn(),
  revokeControlPanelSentryInstallation: vi.fn(),
}));

const { SentryIntegrationCard } = await import("./sentry-integration-card");

const ORG_ID = "org_1";

/**
 * An Organization that is already wired to Sentry must never flash the
 * disconnected state on its way to rendering. The list decides that, so an
 * in-flight list is its own state rather than an empty one.
 */
describe("SentryIntegrationCard", () => {
  it("offers no install form while the installation list is still loading", () => {
    const html = render(new QueryClient());
    expect(html).toContain("Loading Sentry status");
    expect(html).not.toContain("Connect Sentry");
    expect(html).not.toContain("does not publish Flag changes to Sentry");
  });

  it("offers the install form once the list settles empty", () => {
    const html = render(seeded([]));
    expect(html).toContain("Connect Sentry");
  });

  it("withholds the install form from an Organization that already has an active org", () => {
    const html = render(seeded([installation({ status: "active" })]));
    expect(html).not.toContain("Connect Sentry");
  });

  it("offers the install form again once the only installation is revoked", () => {
    const html = render(seeded([installation({ status: "revoked" })]));
    expect(html).toContain("Connect Sentry");
  });
});

function render(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SentryIntegrationCard orgId={ORG_ID} />
    </QueryClientProvider>,
  );
}

function seeded(installations: SentryInstallationStatus[]): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.org.sentryInstallations(ORG_ID), installations);
  return queryClient;
}

function installation(overrides: Partial<SentryInstallationStatus>): SentryInstallationStatus {
  return {
    installationId: "11111111-1111-4111-8111-111111111111",
    orgId: ORG_ID,
    webhookUrl: "https://sentry.io/api/0/organizations/acme/flags/hooks/provider/generic/",
    status: "active",
    lastDeliveredSeq: null,
    lastDeliveredAt: null,
    attemptCount: 0,
    nextAttemptAt: "2026-08-26T00:00:00.000Z",
    latestDeliveryError: null,
    ...overrides,
  };
}
