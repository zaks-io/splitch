import { describe, expect, it } from "vitest";
import { createSplitchClient } from "./client";
import { FakeLogger, stubFetch } from "./test-fixtures";

const EVALUATIONS = {
  "new-checkout": {
    variant: true,
    variantName: "treatment",
    reason: "SPLIT",
    errorCode: null,
    exposureIdentity: "identity-1",
    exposureTicket: "ticket-1",
  },
};

function payloadResponse(headers: Record<string, string> = { etag: '"tag-1"' }): Response {
  return new Response(JSON.stringify({ evaluations: EVALUATIONS }), { headers });
}

function client(fetchImpl: typeof fetch, timeoutMs = 1000) {
  const logger = new FakeLogger();
  return {
    logger,
    client: createSplitchClient({
      apiKey: "sk_test",
      endpoint: "https://edge.test",
      fetch: fetchImpl,
      timeoutMs,
      logger,
    }),
  };
}

describe("evaluateAll over the real fetch adapter", () => {
  it("POSTs the bulk route with the credential, an Idempotency-Key, and no flagKey", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const capturing = ((url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(payloadResponse());
    }) as unknown as typeof fetch;

    const precomputed = await client(capturing).client.evaluateAll({
      targetingKey: "u1",
      attributes: { plan: "pro" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://edge.test/api/sdk/evaluate-all");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test");
    expect(headers["idempotency-key"]).toEqual(expect.any(String));
    expect(headers["x-splitch-sdk-runtime"]).toBe("javascript");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      targetingKey: "u1",
      idType: "user",
      attributes: { plan: "pro" },
    });
    expect(precomputed.etag).toBe('"tag-1"');
  });

  it("surfaces the ETag header verbatim, quotes included", async () => {
    const etag = '"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"';
    const { client: sdk } = client(stubFetch(payloadResponse({ etag })));

    await expect(sdk.evaluateAll({ targetingKey: "u1" })).resolves.toMatchObject({ etag });
  });

  it("fails loud on a 200 with no ETag rather than inventing one", async () => {
    const { client: sdk, logger } = client(stubFetch(payloadResponse({})));

    await expect(sdk.evaluateAll({ targetingKey: "u1" })).rejects.toMatchObject({
      code: "SDK_TRANSPORT_PARSE",
    });
    expect(logger.errors).toHaveLength(1);
  });

  it("fails loud on a body that does not match the payload contract", async () => {
    const malformed = new Response(JSON.stringify({ evaluations: { flag: { variant: true } } }), {
      headers: { etag: '"tag-1"' },
    });
    const { client: sdk } = client(stubFetch(malformed));

    await expect(sdk.evaluateAll({ targetingKey: "u1" })).rejects.toMatchObject({
      code: "SDK_TRANSPORT_PARSE",
    });
  });

  it("maps a local throw to SDK_TRANSPORT_NETWORK and preserves the cause", async () => {
    const thrown = new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    const { client: sdk, logger } = client(stubFetch(() => Promise.reject(thrown)));

    await expect(sdk.evaluateAll({ targetingKey: "u1" })).rejects.toMatchObject({
      code: "SDK_TRANSPORT_NETWORK",
      status: null,
    });
    expect(logger.errors[0]?.detail).toMatchObject({ cause: thrown });
  });

  it("maps a timeout to SDK_TRANSPORT_TIMEOUT, never SERVICE_UNAVAILABLE", async () => {
    const aborting: typeof fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof fetch;

    await expect(
      client(aborting, 5).client.evaluateAll({ targetingKey: "u1" }),
    ).rejects.toMatchObject({ code: "SDK_TRANSPORT_TIMEOUT" });
  });

  it("reports the endpoint's own error code on an HTTP failure", async () => {
    const failure = new Response(JSON.stringify({ code: "APP_MISMATCH", message: "wrong app" }), {
      status: 403,
    });
    const { client: sdk } = client(stubFetch(failure));

    await expect(sdk.evaluateAll({ targetingKey: "u1" })).rejects.toMatchObject({
      code: "APP_MISMATCH",
      status: 403,
    });
  });
});
