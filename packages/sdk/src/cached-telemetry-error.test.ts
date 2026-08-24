import { describe, expect, it } from "vitest";
import { createSplitchClient } from "./client";
import { FakeLogger } from "./test-fixtures";

describe("cached Evaluation telemetry errors", () => {
  it("logs a stable client code and remediation", async () => {
    const logger = new FakeLogger();
    const client = createSplitchClient({
      clientKey: "pk_test",
      logger,
      fetch: ((url: URL | RequestInfo) =>
        Promise.resolve(
          new URL(String(url)).pathname === "/api/sdk/evaluate"
            ? new Response(JSON.stringify({ variant: true }), {
                status: 200,
                headers: { "x-run-id": "run-42", "x-variant-name": "on" },
              })
            : new Response("", { status: 503 }),
        )) as typeof fetch,
    });

    await client.evaluate("checkout", { targetingKey: "u1", idempotencyKey: "cache-fail-1" });
    await client.evaluate("checkout", { targetingKey: "u1", idempotencyKey: "cache-fail-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("SDK_CACHED_TELEMETRY_FAILED");
    expect(logger.errors[0]?.message).toContain("Remediation:");
  });
});
