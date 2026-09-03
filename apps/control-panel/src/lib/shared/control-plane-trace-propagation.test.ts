import { describe, expect, it, vi } from "vitest";
import { createControlPanelAppsClient } from "#lib/shared/control-plane-apps";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SENTRY_TRACE = `${TRACE_ID}-0123456789abcdef-1`;
const BAGGAGE = `sentry-trace_id=${TRACE_ID}`;
const TRACEPARENT = `00-${TRACE_ID}-0123456789abcdef-01`;

vi.mock("@sentry/cloudflare", () => ({
  getActiveSpan: () => undefined,
  getTraceData: (options?: { propagateTraceparent?: boolean }) => ({
    "sentry-trace": "0123456789abcdef0123456789abcdef-0123456789abcdef-1",
    baggage: "sentry-trace_id=0123456789abcdef0123456789abcdef",
    ...(options?.propagateTraceparent ? { traceparent: TRACEPARENT } : {}),
  }),
}));

describe("Control Plane trace propagation", () => {
  it("carries the active Sentry trace over an uninstrumented service binding", async () => {
    let capturedRequest: Request | undefined;
    const client = createControlPanelAppsClient(
      {
        fetch: async (request: Request) => {
          capturedRequest = request;
          return Response.json({ id: "app_checkout", key: "checkout", name: "Checkout" });
        },
      } as unknown as Fetcher,
      { actorId: "user_acme", sessionExpiresAt: 1_800_003_600 },
      "test-control-panel-delegation-secret-1234",
      { nowSeconds: () => 1_800_000_000, nonce: () => "nonce_trace_123456789" },
    );

    await expect(
      client.create({ orgId: "org_acme", name: "Checkout", key: "checkout" }),
    ).rejects.toThrow("invalid response body");

    expect(capturedRequest?.headers.get("sentry-trace")).toBe(SENTRY_TRACE);
    expect(capturedRequest?.headers.get("baggage")).toBe(BAGGAGE);
    expect(capturedRequest?.headers.get("traceparent")).toBe(TRACEPARENT);
  });
});
