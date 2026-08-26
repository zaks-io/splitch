import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type PushInstallationRow, PushInstallationsTable } from "./push-installations-table";

const LABELS = {
  provider: "cloudflare",
  destinationHeading: "Worker endpoint",
  emptyMessage: "This Environment is not connected to a Cloudflare Worker.",
  syncedVersionLabel: "Applied",
} as const;

/**
 * The degraded and error states are the reason this table exists: an operator
 * opens the card to find out why an Environment stopped syncing. Both cards
 * seed a healthy row, so they are covered here instead.
 */
describe("PushInstallationsTable", () => {
  it("reports a stalled backlog in the largest whole unit and the latest error with its HTTP status", () => {
    const html = render({
      pendingCount: 4,
      oldestPendingAgeMs: 3 * 60 * 60 * 1_000 + 42 * 60 * 1_000,
      terminalCount: 1,
      latestDeliveryError: { code: "PUSH_REJECTED", kind: "http", httpStatus: 503 },
    });

    expect(html).toContain("4 pending deliveries");
    expect(html).toContain("Oldest pending: 3 hours");
    expect(html).toContain("1 terminal delivery");
    expect(html).toContain("Latest error: PUSH_REJECTED (http, HTTP 503)");
  });

  it("omits the HTTP status for a transport error and keeps a single pending delivery singular", () => {
    const html = render({
      pendingCount: 1,
      oldestPendingAgeMs: 45_000,
      terminalCount: 0,
      latestDeliveryError: { code: "PUSH_UNREACHABLE", kind: "transport" },
    });

    expect(html).toContain("1 pending delivery ");
    expect(html).toContain("Oldest pending: 45 seconds");
    expect(html).toContain("0 terminal deliveries");
    expect(html).toContain("Latest error: PUSH_UNREACHABLE (transport)");
    expect(html).not.toContain("HTTP");
  });

  it("reads as healthy only when nothing is pending and no error is recorded", () => {
    const html = render({
      pendingCount: 0,
      oldestPendingAgeMs: null,
      terminalCount: 0,
      latestDeliveryError: null,
    });

    expect(html).toContain("Oldest pending: none");
    expect(html).not.toContain("Latest error");
  });

  it("renders the provider's empty message with no Disconnect action", () => {
    const html = renderToStaticMarkup(
      <PushInstallationsTable labels={LABELS} onRevoke={() => {}} rows={[]} />,
    );

    expect(html).toContain(LABELS.emptyMessage);
    expect(html).not.toContain("Disconnect");
  });
});

function render(
  health: Pick<
    PushInstallationRow,
    "pendingCount" | "oldestPendingAgeMs" | "terminalCount" | "latestDeliveryError"
  >,
) {
  const row: PushInstallationRow = {
    installationId: "cfi_1",
    destinationUrl:
      "https://splitch-config.customer.workers.dev/integrations/splitch/configuration",
    environmentVersion: 12,
    syncedVersion: 9,
    status: "active",
    ...health,
  };
  return renderToStaticMarkup(
    <PushInstallationsTable labels={LABELS} onRevoke={() => {}} rows={[row]} />,
  );
}
