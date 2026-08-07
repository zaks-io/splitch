import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";
import { assertBootstrapShape, stubSplitchEdgeFetch } from "./testHelpers";

describe("HTTP action evaluateAll bootstrap (fetch stubbed at fixture seam)", () => {
  const envBackup = {
    apiKey: process.env.SPLITCH_API_KEY,
    endpoint: process.env.SPLITCH_ENDPOINT,
  };

  afterEach(() => {
    if (envBackup.apiKey === undefined) {
      delete process.env.SPLITCH_API_KEY;
    } else {
      process.env.SPLITCH_API_KEY = envBackup.apiKey;
    }
    if (envBackup.endpoint === undefined) {
      delete process.env.SPLITCH_ENDPOINT;
    } else {
      process.env.SPLITCH_ENDPOINT = envBackup.endpoint;
    }
  });

  it("returns a shape-valid browser bootstrap payload", async () => {
    process.env.SPLITCH_API_KEY = "sk_convex_fixture";
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const edge = stubSplitchEdgeFetch();
    const t = convexTest(schema, modules);

    try {
      const response = await t.fetch("/splitch/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetingKey: "user-bootstrap",
          attributes: { plan: "pro" },
          idempotencyKey: "batch-1",
        }),
      });

      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      assertBootstrapShape(payload);

      expect(payload.etag).toBe('"convex-fixture-1"');
      expect(payload.context).toEqual({
        targetingKey: "user-bootstrap",
        idType: "user",
        attributes: { plan: "pro" },
      });
      expect(payload.evaluations["new-checkout"]).toMatchObject({
        variant: true,
        variantName: "treatment",
        reason: "SPLIT",
        exposureTicket: "ticket-convex-1",
      });

      // Round-trip through JSON the way an SSR page would embed it.
      const rehydrated = JSON.parse(JSON.stringify(payload));
      assertBootstrapShape(rehydrated);
      expect(rehydrated).toEqual(payload);

      expect(edge.calls.some((call) => call.url.includes("/api/sdk/evaluate-all"))).toBe(true);
      expect(edge.calls[0]?.authorization).toBe("Bearer sk_convex_fixture");
    } finally {
      edge.restore();
    }
  });

  it("fails loud when SPLITCH_API_KEY is missing", async () => {
    delete process.env.SPLITCH_API_KEY;
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const t = convexTest(schema, modules);

    // Missing API Key must throw — no silent empty bootstrap.
    await expect(
      t.fetch("/splitch/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetingKey: "user-bootstrap", idempotencyKey: "batch-2" }),
      }),
    ).rejects.toThrow(/SPLITCH_API_KEY/);
  });
});
