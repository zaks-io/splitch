import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";
import { stubSplitchEdgeFetch } from "./testHelpers";

describe("Convex action evaluate round-trip (fetch stubbed at fixture seam)", () => {
  const envBackup = {
    clientKey: process.env.SPLITCH_CLIENT_KEY,
    endpoint: process.env.SPLITCH_ENDPOINT,
  };

  afterEach(() => {
    if (envBackup.clientKey === undefined) {
      delete process.env.SPLITCH_CLIENT_KEY;
    } else {
      process.env.SPLITCH_CLIENT_KEY = envBackup.clientKey;
    }
    if (envBackup.endpoint === undefined) {
      delete process.env.SPLITCH_ENDPOINT;
    } else {
      process.env.SPLITCH_ENDPOINT = envBackup.endpoint;
    }
  });

  it("evaluate returns the Variant from a stubbed edge inside an action", async () => {
    process.env.SPLITCH_CLIENT_KEY = "pk_convex_fixture";
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const edge = stubSplitchEdgeFetch();
    const t = convexTest(schema, modules);

    try {
      const value = await t.action(api.flags.evaluateFlag, {
        flagKey: "new-checkout",
        targetingKey: "user-1",
        idempotencyKey: "eval-1",
        defaultValue: false,
      });

      expect(value).toBe(true);
      expect(edge.calls.some((call) => call.url.includes("/api/sdk/evaluate"))).toBe(true);
      expect(edge.calls[0]?.authorization).toBe("Bearer pk_convex_fixture");
    } finally {
      edge.restore();
    }
  });

  it("threads an action-resolved boolean and Variant into a mutation", async () => {
    process.env.SPLITCH_CLIENT_KEY = "pk_convex_fixture";
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const edge = stubSplitchEdgeFetch();
    const t = convexTest(schema, modules);

    try {
      const result = await t.action(api.checkout.checkout, {
        targetingKey: "user-boundary",
        idempotencyKey: "eval-boundary",
      });

      expect(result).toEqual({
        experience: "new",
        variantName: "treatment",
      });
      expect(edge.calls).toHaveLength(1);
      await expect(
        t.query(api.checkoutProbe.getCheckoutRequest, {
          targetingKey: "user-boundary",
        }),
      ).resolves.toMatchObject(result);
    } finally {
      edge.restore();
    }
  });

  it("does not call the mutation when Evaluation returns ERROR", async () => {
    process.env.SPLITCH_CLIENT_KEY = "pk_convex_fixture";
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const edge = stubSplitchEdgeFetch({ evaluateStatus: 503 });
    const t = convexTest(schema, modules);

    try {
      await expect(
        t.action(api.checkout.checkout, {
          targetingKey: "user-error",
          idempotencyKey: "eval-error",
        }),
      ).rejects.toMatchObject({
        name: "FlagEvaluationError",
        errorCode: "SERVICE_UNAVAILABLE",
      });
      await expect(
        t.query(api.checkoutProbe.getCheckoutRequest, {
          targetingKey: "user-error",
        }),
      ).resolves.toBeNull();
    } finally {
      edge.restore();
    }
  });

  it("evaluateAndStore persists the resolution for query consumers", async () => {
    process.env.SPLITCH_CLIENT_KEY = "pk_convex_fixture";
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const edge = stubSplitchEdgeFetch();
    const t = convexTest(schema, modules);

    try {
      const details = await t.action(api.flags.evaluateAndStore, {
        flagKey: "new-checkout",
        targetingKey: "user-2",
        idempotencyKey: "eval-2",
      });

      expect(details).toMatchObject({
        value: true,
        variantName: "treatment",
        reason: "SPLIT",
        errorCode: null,
      });

      const stored = await t.query(api.flags.getStoredEvaluation, {
        targetingKey: "user-2",
        flagKey: "new-checkout",
      });
      expect(stored).toMatchObject({
        value: true,
        variantName: "treatment",
        reason: "SPLIT",
      });
    } finally {
      edge.restore();
    }
  });

  it("evaluateAndStore upserts so a repeat pair does not break .unique() reads", async () => {
    process.env.SPLITCH_CLIENT_KEY = "pk_convex_fixture";
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const edge = stubSplitchEdgeFetch();
    const t = convexTest(schema, modules);

    try {
      await t.action(api.flags.evaluateAndStore, {
        flagKey: "new-checkout",
        targetingKey: "user-upsert",
        idempotencyKey: "eval-upsert-1",
      });
      await t.action(api.flags.evaluateAndStore, {
        flagKey: "new-checkout",
        targetingKey: "user-upsert",
        idempotencyKey: "eval-upsert-2",
      });

      const stored = await t.query(api.flags.getStoredEvaluation, {
        targetingKey: "user-upsert",
        flagKey: "new-checkout",
      });
      expect(stored).toMatchObject({
        value: true,
        variantName: "treatment",
        reason: "SPLIT",
      });
    } finally {
      edge.restore();
    }
  });

  it("fails loud when SPLITCH_CLIENT_KEY is missing (no silent degradation)", async () => {
    delete process.env.SPLITCH_CLIENT_KEY;
    process.env.SPLITCH_ENDPOINT = "https://edge.test";
    const t = convexTest(schema, modules);

    await expect(
      t.action(api.flags.evaluateFlag, {
        flagKey: "new-checkout",
        targetingKey: "user-3",
        idempotencyKey: "eval-3",
      }),
    ).rejects.toThrow(/SPLITCH_CLIENT_KEY/);
  });
});
