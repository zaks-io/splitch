import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
} from "./exposure-redemption-claim";
import { EXPOSURE_REDEMPTION_PENDING_LEASE_MS } from "./exposure-redemption-claim-core";
import {
  type ExposureRedemptionClaimDoContext,
  handleExposureRedemptionClaimFetch,
  runExposureRedemptionClaimAlarm,
} from "./exposure-redemption-do-handler";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

/**
 * Production handler unit coverage. Miniflare / real-DO cases live in
 * `exposure-redemption-do-miniflare.test.ts`.
 */

function memoryCtx(): ExposureRedemptionClaimDoContext {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (key: string | string[]) => {
        if (Array.isArray(key)) for (const k of key) map.delete(k);
        else map.delete(key);
      },
      list: async <T>() => new Map(Array.from(map.entries()) as Array<[string, T]>),
      getAlarm: async () => alarm,
      setAlarm: async (scheduledTime: number) => {
        alarm = scheduledTime;
      },
    } as unknown as DurableObjectStorage,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://exposure-redemption-claim.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const claimBody = { exposureId: "e1", ticketFingerprint: "fp", nowMs: 1_000 };

describe("handleExposureRedemptionClaimFetch (production handler)", () => {
  it("runs claim/release/markSealed/acknowledge inside blockConcurrencyWhile", async () => {
    const ctx = memoryCtx();
    let gated = 0;
    ctx.blockConcurrencyWhile = async <T>(fn: () => Promise<T>) => {
      gated += 1;
      return fn();
    };
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody))).json(),
    ).toEqual({ status: "acquired" });
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody))).json(),
    ).toEqual({ status: "busy" });
    expect(
      (await handleExposureRedemptionClaimFetch(ctx, post("/markSealed", claimBody))).status,
    ).toBe(200);
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, post("/acknowledge", claimBody))).json(),
    ).toEqual({ status: "accepted" });
    expect(gated).toBeGreaterThanOrEqual(4);
  });

  it("rejects non-POST, unknown paths, malformed bodies, and non-finite nowMs", async () => {
    const ctx = memoryCtx();
    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          new Request("https://do/claim", { method: "GET" }),
        )
      ).status,
    ).toBe(404);
    expect((await handleExposureRedemptionClaimFetch(ctx, post("/other", claimBody))).status).toBe(
      404,
    );
    expect(
      (await handleExposureRedemptionClaimFetch(ctx, post("/claim", { exposureId: "e1" }))).status,
    ).toBe(400);
    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          post("/claim", { ...claimBody, nowMs: Number.NaN }),
        )
      ).status,
    ).toBe(400);
  });

  it("does not list the full keyspace on the claim hot path", async () => {
    const ctx = memoryCtx();
    let listed = 0;
    (ctx.storage as unknown as { list: () => Promise<Map<string, unknown>> }).list = async () => {
      listed += 1;
      return new Map();
    };
    await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, post("/markSealed", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, post("/acknowledge", claimBody));
    expect(listed).toBe(0);
  });

  it("release clears pending so a later claim can acquire", async () => {
    const ctx = memoryCtx();
    await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, post("/release", claimBody));
    expect(
      await (
        await handleExposureRedemptionClaimFetch(
          ctx,
          post("/claim", { ...claimBody, exposureId: "e2", nowMs: 2 }),
        )
      ).json(),
    ).toEqual({ status: "acquired" });
  });

  it("arms a pending-lease alarm on claim and never pushes the alarm later on seal", async () => {
    const ctx = memoryCtx();
    const now = Date.now();
    await handleExposureRedemptionClaimFetch(ctx, post("/claim", { ...claimBody, nowMs: now }));
    const pendingAlarm = now + EXPOSURE_REDEMPTION_PENDING_LEASE_MS;
    expect(await ctx.storage.getAlarm()).toBe(pendingAlarm);

    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          post("/markSealed", { ...claimBody, nowMs: now }),
        )
      ).status,
    ).toBe(200);
    // Sealed records live for the claim TTL, but setExpiryAlarm must not push a
    // nearer pending alarm later — otherwise short-lived records outlive their TTL.
    expect(await ctx.storage.getAlarm()).toBe(pendingAlarm);

    await ctx.storage.put("exposure:old", {
      ticketFingerprint: "x",
      delivery: "pending",
      expiresAt: now - 1,
    });
    const nearer = now + 1_000;
    await ctx.storage.put("exposure:near", {
      ticketFingerprint: "y",
      delivery: "pending",
      expiresAt: nearer,
    });
    await runExposureRedemptionClaimAlarm(ctx.storage);
    expect(await ctx.storage.get("exposure:old")).toBeUndefined();
    expect(await ctx.storage.getAlarm()).toBe(nearer);
  });
});

describe("DurableExposureRedemptionClaimStore HTTP guards", () => {
  it("throws when the Durable Object returns a non-OK HTTP status (even with a success-shaped body)", async () => {
    const namespace: ExposureRedemptionClaimNamespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ status: "acquired" }), { status: 500 }),
      }),
    };
    await expect(
      new DurableExposureRedemptionClaimStore(namespace).claim({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: "e1",
        ticketFingerprint: "fp",
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
