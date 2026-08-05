import { describe, expect, it } from "vitest";
import { createSplitchClient } from "./client";
import { FakeLogger, fetchTransport, stubFetch, TRANSPORT_REQUEST } from "./test-fixtures";

/**
 * SPL-323: transport failures must not collapse onto SERVICE_UNAVAILABLE.
 * Each mode gets a distinct SDK_TRANSPORT_* code, and logger.error receives
 * the original error object (mutation check: bare `catch {}` makes these red).
 */
describe("transport failure modes: distinct codes + preserved cause (SPL-323)", () => {
  it("local throw -> SDK_TRANSPORT_NETWORK and logger.error receives the original error", async () => {
    const thrown = new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    const logger = new FakeLogger();
    const client = createSplitchClient({
      clientKey: "ck_test",
      fetch: stubFetch(() => Promise.reject(thrown)),
      logger,
    });

    const details = await client.evaluateDetails("flag", {
      targetingKey: "u1",
      defaultValue: "control",
      idempotencyKey: "transport-network-1",
    });

    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("SDK_TRANSPORT_NETWORK");
    expect(details.errorCode).not.toBe("SERVICE_UNAVAILABLE");
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("SDK_TRANSPORT_NETWORK");
    expect(logger.errors[0]?.detail).toMatchObject({ cause: thrown });
    const detail = logger.errors[0]?.detail as { cause: TypeError };
    expect(detail.cause.name).toBe("TypeError");
    expect(detail.cause.message).toBe(thrown.message);
    expect(detail.cause.stack).toBe(thrown.stack);
  });

  it("timeout/abort -> SDK_TRANSPORT_TIMEOUT and logger.error receives the AbortError", async () => {
    const logger = new FakeLogger();
    const aborting: typeof fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof fetch;

    const client = createSplitchClient({
      clientKey: "ck_test",
      fetch: aborting,
      timeoutMs: 5,
      logger,
    });

    const details = await client.evaluateDetails("flag", {
      targetingKey: "u1",
      defaultValue: "control",
      idempotencyKey: "transport-timeout-1",
    });

    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("SDK_TRANSPORT_TIMEOUT");
    expect(details.errorCode).not.toBe("SERVICE_UNAVAILABLE");
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("SDK_TRANSPORT_TIMEOUT");
    const detail = logger.errors[0]?.detail as { cause: Error };
    expect(detail.cause.name).toBe("AbortError");
  });

  it("unparseable body -> SDK_TRANSPORT_PARSE and logger.error receives the parse error", async () => {
    const logger = new FakeLogger();
    const client = createSplitchClient({
      clientKey: "ck_test",
      fetch: stubFetch(new Response("not json", { status: 200 })),
      logger,
    });

    const details = await client.evaluateDetails("flag", {
      targetingKey: "u1",
      defaultValue: "control",
      idempotencyKey: "transport-parse-1",
    });

    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("SDK_TRANSPORT_PARSE");
    expect(details.errorCode).not.toBe("SERVICE_UNAVAILABLE");
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("SDK_TRANSPORT_PARSE");
    const detail = logger.errors[0]?.detail as { cause: unknown };
    expect(detail.cause).toBeDefined();
  });

  it("HTTP 503 from the server remains SERVICE_UNAVAILABLE (server said so)", async () => {
    const logger = new FakeLogger();
    const client = createSplitchClient({
      clientKey: "ck_test",
      fetch: stubFetch(new Response("", { status: 503 })),
      logger,
    });

    const details = await client.evaluateDetails("flag", {
      targetingKey: "u1",
      defaultValue: "x",
      idempotencyKey: "transport-503-1",
    });

    expect(details.errorCode).toBe("SERVICE_UNAVAILABLE");
    expect(logger.errors).toHaveLength(1);
  });

  it("peek and verify classify the same three transport modes", async () => {
    const thrown = new TypeError("network down");
    const network = fetchTransport(stubFetch(() => Promise.reject(thrown)));
    const parse = fetchTransport(stubFetch(new Response("{", { status: 200 })));
    const aborting: typeof fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const timeout = fetchTransport(aborting, 5);

    await expect(network.peek(TRANSPORT_REQUEST)).resolves.toMatchObject({
      errorCode: "SDK_TRANSPORT_NETWORK",
      cause: thrown,
    });
    await expect(timeout.peek(TRANSPORT_REQUEST)).resolves.toMatchObject({
      errorCode: "SDK_TRANSPORT_TIMEOUT",
    });
    await expect(parse.peek(TRANSPORT_REQUEST)).resolves.toMatchObject({
      errorCode: "SDK_TRANSPORT_PARSE",
    });

    await expect(network.verify(TRANSPORT_REQUEST)).resolves.toMatchObject({
      errorCode: "SDK_TRANSPORT_NETWORK",
      cause: thrown,
    });
    await expect(timeout.verify(TRANSPORT_REQUEST)).resolves.toMatchObject({
      errorCode: "SDK_TRANSPORT_TIMEOUT",
    });
    await expect(parse.verify(TRANSPORT_REQUEST)).resolves.toMatchObject({
      errorCode: "SDK_TRANSPORT_PARSE",
    });
  });
});
