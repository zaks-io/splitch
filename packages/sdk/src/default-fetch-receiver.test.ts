import { describe, expect, it } from "vitest";
import { createSplitchClient } from "./client";
import { FakeLogger } from "./test-fixtures";

describe("createSplitchClient: default fetch receiver (browser Window.fetch)", () => {
  it("keeps a Window-like receiver (unbound method call would Illegal-invocation)", async () => {
    const previousFetch = globalThis.fetch;
    const logger = new FakeLogger();
    // Mimic Window.fetch: calling the function with the wrong `this` throws.
    // The SDK stores fetch on a config object and invokes it as a method; without
    // binding at the seam that path is unusable in every browser.
    const windowLikeFetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(
        new Response(JSON.stringify({ value: true, variantName: "on", reason: "SPLIT" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: windowLikeFetch,
    });

    try {
      const client = createSplitchClient({
        clientKey: "ck_test",
        endpoint: "https://edge.test",
        logger,
        // Intentionally omit `fetch` — exercise the default seam.
      });
      const details = await client.verify("flag", {
        targetingKey: "u1",
        defaultValue: false,
      });
      expect(details.reason).not.toBe("ERROR");
      expect(details).toMatchObject({ value: true, reason: "SPLIT" });
      expect(logger.errors).toHaveLength(0);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: previousFetch,
      });
    }
  });
});
