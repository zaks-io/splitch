import { describe, expect, it, vi } from "vitest";
import { classifyBodyReadError, readFailure, withTimeout } from "./http";
import { createBrowserFetchTransport } from "./transport";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const OK_EVAL = {
  evaluations: {
    flag: {
      variant: true,
      variantName: "on",
      reason: "SPLIT",
      errorCode: null,
      exposureTicket: "t",
      exposureIdentity: "id",
    },
  },
};

describe("createBrowserFetchTransport: receiver (B1)", () => {
  it("calls a user-supplied fetchImpl as a plain call (receiver undefined)", async () => {
    const fetchImpl = function fetchImpl(
      this: unknown,
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError(
          "Failed to execute 'fetch' on 'Window': Illegal invocation (receiver must be undefined)",
        );
      }
      const url = String(input);
      if (url.includes("evaluate-all")) {
        return Promise.resolve(jsonResponse(200, OK_EVAL, { etag: '"e1"' }));
      }
      return Promise.resolve(
        jsonResponse(202, {
          results: [
            {
              exposureId: "11111111-1111-4111-8111-111111111111",
              status: "accepted",
              code: null,
            },
          ],
        }),
      );
    };

    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const evalResult = await transport.evaluateAll({
      targetingKey: "u1",
      idType: "user",
      attributes: {},
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(evalResult.status).toBe(200);
    expect(evalResult.evaluations).not.toBeNull();
    expect(evalResult.etag).toBe('"e1"');

    const redeem = await transport.redeemExposures([
      {
        exposureId: "11111111-1111-4111-8111-111111111111",
        exposureTicket: "t",
        clientTimestamp: "2026-08-08T00:00:00.000Z",
      },
    ]);
    expect(redeem.results).toHaveLength(1);
  });
});

describe("createBrowserFetchTransport: auth and keepalive", () => {
  it("sends If-None-Match and accepts a 304 without parsing a body", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"e1"');
      return new Response(null, { status: 304 });
    });
    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      transport.evaluateAll({
        targetingKey: "u1",
        idType: "user",
        attributes: {},
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        ifNoneMatch: '"e1"',
      }),
    ).resolves.toEqual({ status: 304, evaluations: null, etag: null });
  });

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
        return jsonResponse(200, OK_EVAL, { etag: '"e1"' });
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

describe("createBrowserFetchTransport: failure surface (B4)", () => {
  it("maps !response.ok evaluate-all to a failure (M18)", async () => {
    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 1000,
      fetchImpl: (async () =>
        jsonResponse(500, {
          code: "INTERNAL_SERVER_ERROR",
          message: "evaluation failed",
          details: { fault: "evaluation failed" },
        })) as typeof fetch,
    });
    const result = await transport.evaluateAll({
      targetingKey: "u1",
      idType: "user",
      attributes: {},
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.evaluations).toBeNull();
    expect(result.etag).toBeNull();
    expect(result.status).toBe(500);
    expect(result.errorCode).toBe("INTERNAL_SERVER_ERROR");
  });

  it("rejects evaluate-all success bodies without an ETag (M19)", async () => {
    const transport = createBrowserFetchTransport({
      credential: "pk_test",
      endpoint: "https://edge.test",
      timeoutMs: 1000,
      fetchImpl: (async () => jsonResponse(200, OK_EVAL)) as typeof fetch,
    });
    const result = await transport.evaluateAll({
      targetingKey: "u1",
      idType: "user",
      attributes: {},
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.evaluations).toBeNull();
    expect(result.etag).toBeNull();
    expect(result.errorCode).toBe("SDK_TRANSPORT_PARSE");
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
