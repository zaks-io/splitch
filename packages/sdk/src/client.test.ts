import { describe, expect, it } from "vitest";
import { createFetchTransport, createSplitchClient } from "./client.js";
import { FakeLogger, FakeTransport, httpError, ok, transportFailure } from "./test-fixtures.js";
import type { Transport, TransportRequest } from "./transport.js";

const REQ: TransportRequest = {
  flagKey: "flag",
  targetingKey: "u1",
  idType: "user",
  attributes: {},
};

/** Build a stub `fetch` returning a scripted Response — no real network. */
function stubFetch(response: Response | (() => Promise<Response>)): typeof fetch {
  return (() =>
    typeof response === "function" ? response() : Promise.resolve(response)) as typeof fetch;
}

function transport(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return createFetchTransport({
    credential: "ck_test",
    endpoint: "https://edge.test",
    timeoutMs,
    fetchImpl,
  });
}

function clientWith(transport: Transport, logger = new FakeLogger()) {
  return {
    logger,
    client: createSplitchClient({ clientKey: "ck_test", transport, logger }),
  };
}

describe("createSplitchClient: construction", () => {
  it("requires exactly one of clientKey or apiKey", () => {
    expect(() => createSplitchClient({})).toThrow(/exactly one/);
    expect(() => createSplitchClient({ clientKey: "ck", apiKey: "ak" })).toThrow(/exactly one/);
    expect(() =>
      createSplitchClient({ apiKey: "ak", transport: new FakeTransport([]) }),
    ).not.toThrow();
  });

  it("rejects a non-zero retries (never retry the Exposure-bearing call)", () => {
    expect(() => createSplitchClient({ clientKey: "ck", retries: 1 })).toThrow(/retries must be 0/);
    expect(() =>
      createSplitchClient({ clientKey: "ck", retries: 0, transport: new FakeTransport([]) }),
    ).not.toThrow();
  });
});

describe("evaluate / evaluateDetails: 200 success rows", () => {
  it("200 rule-resolved -> SPLIT + unwrapped variant value", async () => {
    const { client } = clientWith(new FakeTransport([ok("treatment", "run-1")]));
    expect(await client.evaluate("checkout", { targetingKey: "u1" })).toBe("treatment");
  });

  it("200 no-match (variant null) -> DEFAULT + Default Variant", async () => {
    const { client } = clientWith(new FakeTransport([ok(null, "run-1")]));
    const details = await client.evaluateDetails("checkout", {
      targetingKey: "u1",
      defaultValue: "control",
    });
    expect(details.reason).toBe("DEFAULT");
    expect(details.value).toBe("control");
  });
});

describe("wire request: idType default", () => {
  it("omitted idType -> wire request carries idType 'user'", async () => {
    const fake = new FakeTransport([ok(true, "run-1")]);
    const { client } = clientWith(fake);
    await client.evaluate("flag", { targetingKey: "u1" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.idType).toBe("user");
  });

  it("explicit idType overrides the default and rides the wire", async () => {
    const fake = new FakeTransport([ok(true, "run-1")]);
    const { client } = clientWith(fake);
    await client.evaluate("flag", { targetingKey: "ws1", idType: "workspace" });
    expect(fake.calls[0]?.idType).toBe("workspace");
  });
});

describe("fail-loud: every error row returns Default Variant + reason ERROR + no retry + loud log", () => {
  const rows: { label: string; result: ReturnType<typeof httpError>; errorCode: string }[] = [
    { label: "503", result: httpError(503), errorCode: "SERVICE_UNAVAILABLE" },
    { label: "network/timeout", result: transportFailure(), errorCode: "SERVICE_UNAVAILABLE" },
    { label: "404", result: httpError(404), errorCode: "FLAG_NOT_FOUND" },
    { label: "401", result: httpError(401), errorCode: "UNAUTHORIZED" },
    { label: "400", result: httpError(400), errorCode: "VALIDATION_ERROR" },
  ];

  for (const row of rows) {
    it(`${row.label} -> ERROR ${row.errorCode}, Default Variant, no second call, loud log`, async () => {
      const fake = new FakeTransport([row.result]);
      const { client, logger } = clientWith(fake);
      const details = await client.evaluateDetails("flag", {
        targetingKey: "u1",
        defaultValue: "control",
      });

      expect(details.reason).toBe("ERROR");
      expect(details.errorCode).toBe(row.errorCode);
      expect(details.value).toBe("control");
      // No retry of the Exposure-bearing call: exactly one transport call.
      expect(fake.calls).toHaveLength(1);
      // Loud, never silent.
      expect(logger.errors).toHaveLength(1);
      expect(logger.errors[0]?.message).toContain("failed-loud");
    });
  }
});

describe("createFetchTransport (real wire adapter): stub fetch, no network", () => {
  it("200 -> extracts variant from the bare body and runId from the X-Run-Id header", async () => {
    const t = transport(
      stubFetch(
        new Response(JSON.stringify({ variant: "treatment" }), {
          status: 200,
          headers: { "x-run-id": "run-42" },
        }),
      ),
    );
    const result = await t.evaluate(REQ);
    expect(result.status).toBe(200);
    expect(result.variant).toBe("treatment");
    expect(result.runId).toBe("run-42");
  });

  it("non-2xx -> surfaces the status, no variant, no runId", async () => {
    const t = transport(stubFetch(new Response("", { status: 404 })));
    const result = await t.evaluate(REQ);
    expect(result.status).toBe(404);
    expect(result.variant).toBeNull();
    expect(result.runId).toBeNull();
  });

  it("200 with an unparseable body -> folds to a transport failure (status null -> ERROR)", async () => {
    const t = transport(stubFetch(new Response("not json", { status: 200 })));
    const result = await t.evaluate(REQ);
    expect(result.status).toBeNull(); // parse failure -> fail loud
    expect(result.variant).toBeNull();
  });

  it("a thrown fetch (network error) -> status null", async () => {
    const t = transport(stubFetch(() => Promise.reject(new TypeError("network down"))));
    const result = await t.evaluate(REQ);
    expect(result.status).toBeNull();
  });

  it("timeout: a fetch that never resolves is aborted -> status null (reason ERROR)", async () => {
    // The stub honours the AbortSignal the adapter wires to its timeout.
    const aborting: typeof fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;

    const t = transport(aborting, 5); // 5ms timeout
    const result = await t.evaluate(REQ);
    expect(result.status).toBeNull();
  });

  it("peek calls /api/sdk/peek and preserves the route's INSUFFICIENT_SCOPES error", async () => {
    let seenUrl = "";
    const t = transport(((url: URL | RequestInfo) => {
      seenUrl = String(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: "INSUFFICIENT_SCOPES",
            message: "API Key required for this route",
            details: { requiredScopes: ["data-plane:evaluate"], heldScopes: [] },
          }),
          { status: 403 },
        ),
      );
    }) as typeof fetch);

    const result = await t.peek(REQ);
    expect(seenUrl).toBe("https://edge.test/api/sdk/peek");
    expect(result.status).toBe(403);
    expect(result.errorCode).toBe("INSUFFICIENT_SCOPES");
    expect(result.errorMessage).toBe("API Key required for this route");
  });

  it("verify calls /api/sdk/verify and parses ResolutionDetails", async () => {
    let seenUrl = "";
    const t = transport(((url: URL | RequestInfo) => {
      seenUrl = String(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({ value: "treatment", variantName: "treatment", reason: "SPLIT" }),
          { status: 200 },
        ),
      );
    }) as typeof fetch);

    const result = await t.verify(REQ);
    expect(seenUrl).toBe("https://edge.test/api/sdk/verify");
    expect(result.status).toBe(200);
    expect(result.details).toEqual({
      value: "treatment",
      variantName: "treatment",
      reason: "SPLIT",
    });
  });

  it("end-to-end through createSplitchClient with an injected fetch fails loud on a 503", async () => {
    const logger = new FakeLogger();
    const client = createSplitchClient({
      clientKey: "ck_test",
      fetch: stubFetch(new Response("", { status: 503 })),
      logger,
    });
    const details = await client.evaluateDetails("flag", { targetingKey: "u1", defaultValue: "x" });
    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("SERVICE_UNAVAILABLE");
    expect(details.value).toBe("x");
    expect(logger.errors).toHaveLength(1);
  });
});
