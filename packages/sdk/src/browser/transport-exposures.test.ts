import { describe, expect, it, vi } from "vitest";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";
import { createBrowserFetchTransport } from "./transport";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createBrowserFetchTransport: exposure delivery", () => {
  it("omits keepalive unless explicitly requested", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(202, {
        results: [
          { exposureId: "11111111-1111-4111-8111-111111111111", status: "accepted", code: null },
        ],
      }),
    );
    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await transport.redeemExposures(
      [
        {
          exposureId: "11111111-1111-4111-8111-111111111111",
          exposureTicket: "t",
          clientTimestamp: "2026-08-08T00:00:00.000Z",
        },
      ],
      { keepalive: false },
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.keepalive).toBeUndefined();
  });

  it("maps non-ok non-202 exposures responses to failure (M20)", async () => {
    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 1000,
      fetchImpl: (async () =>
        jsonResponse(400, {
          code: "VALIDATION_ERROR",
          message: "invalid exposure batch",
          details: {
            issues: [{ path: ["exposures"], message: "invalid exposure batch" }],
          },
        })) as typeof fetch,
    });
    const result = await transport.redeemExposures([
      {
        exposureId: "11111111-1111-4111-8111-111111111111",
        exposureTicket: "t",
        clientTimestamp: "2026-08-08T00:00:00.000Z",
      },
    ]);
    expect(result.results).toBeNull();
    expect(result.status).toBe(400);
    expect(result.errorCode).toBe("VALIDATION_ERROR");
  });
});

describe("exposure batch caps are imported into the browser transport path", () => {
  it("exports match the Worker-facing ceilings", () => {
    expect(EXPOSURE_BATCH_MAX_ITEMS).toBe(25);
    expect(EXPOSURE_BATCH_MAX_BODY_BYTES).toBe(32 * 1024);
  });
});
