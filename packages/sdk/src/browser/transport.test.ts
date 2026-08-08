import { describe, expect, it, vi } from "vitest";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";
import { classifyBodyReadError, readFailure, withTimeout } from "./http";
import { createBrowserFetchTransport } from "./transport";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("createBrowserFetchTransport", () => {
  it("sends Authorization bearer on evaluate-all and exposures", async () => {
    const calls: { url: string; authorization: string | null; keepalive?: boolean }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        keepalive: init?.keepalive,
      });
      if (url.includes("evaluate-all")) {
        return jsonResponse(
          200,
          {
            evaluations: {
              flag: {
                variant: true,
                variantName: "on",
                reason: "SPLIT",
                errorCode: null,
                exposureTicket: "t",
              },
            },
          },
          { etag: '"e1"' },
        );
      }
      return jsonResponse(202, {
        results: [
          { exposureId: "11111111-1111-4111-8111-111111111111", status: "accepted", code: null },
        ],
      });
    });

    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await transport.evaluateAll({
      targetingKey: "u1",
      idType: "user",
      attributes: {},
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    await transport.redeemExposures(
      [
        {
          exposureId: "11111111-1111-4111-8111-111111111111",
          exposureTicket: "t",
          clientTimestamp: "2026-08-08T00:00:00.000Z",
        },
      ],
      { keepalive: true },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBe("Bearer pk_test");
    expect(calls[1]?.authorization).toBe("Bearer pk_test");
    expect(calls[1]?.keepalive).toBe(true);
  });

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

  it("aborts via withTimeout when the timer fires", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await transport.evaluateAll({
      targetingKey: "u1",
      idType: "user",
      attributes: {},
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.errorCode).toBe("SDK_TRANSPORT_TIMEOUT");
  });
});

describe("browser http helpers", () => {
  it("withTimeout aborts the signal when the timer fires", async () => {
    let aborted = false;
    await expect(
      withTimeout(15, (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(true);
  });

  it("readFailure maps an abort mid error-body to SDK_TRANSPORT_TIMEOUT (SPL-323)", async () => {
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const response = {
      status: 503,
      json: () => Promise.reject(aborted),
    } as unknown as Response;
    await expect(readFailure(response)).resolves.toMatchObject({
      errorCode: "SDK_TRANSPORT_TIMEOUT",
      cause: aborted,
    });
  });

  it("classifyBodyReadError maps AbortError to timeout, not parse", () => {
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    expect(classifyBodyReadError(aborted).errorCode).toBe("SDK_TRANSPORT_TIMEOUT");
    expect(classifyBodyReadError(new Error("bad json")).errorCode).toBe("SDK_TRANSPORT_PARSE");
  });
});

describe("exposure batch caps are imported into the browser transport path", () => {
  it("exports match the Worker-facing ceilings", () => {
    expect(EXPOSURE_BATCH_MAX_ITEMS).toBe(25);
    expect(EXPOSURE_BATCH_MAX_BODY_BYTES).toBe(32 * 1024);
  });
});
