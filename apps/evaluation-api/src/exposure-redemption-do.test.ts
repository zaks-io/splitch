import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
} from "./exposure-redemption-claim";
import { EXPOSURE_REDEMPTION_CLAIM_TTL_MS } from "./exposure-redemption-claim-core";
import {
  claimMemoryCtx,
  claimPost,
  simulateClaimAlarm,
} from "./exposure-redemption-do-test-fixtures";
import { handleExposureRedemptionClaimFetch } from "./exposure-redemption-do-handler";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

const claimBody = { exposureId: "e1", ticketFingerprint: "fp", nowMs: 1_000 };

describe("handleExposureRedemptionClaimFetch (production handler)", () => {
  it("runs claim/release/markSealed/acknowledge inside blockConcurrencyWhile", async () => {
    const ctx = claimMemoryCtx();
    let gated = 0;
    ctx.blockConcurrencyWhile = async <T>(fn: () => Promise<T>) => {
      gated += 1;
      return fn();
    };
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, claimPost("/claim", claimBody))).json(),
    ).toEqual({ status: "acquired" });
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, claimPost("/claim", claimBody))).json(),
    ).toEqual({ status: "busy" });
    expect(
      (await handleExposureRedemptionClaimFetch(ctx, claimPost("/markSealed", claimBody))).status,
    ).toBe(200);
    expect(
      await (
        await handleExposureRedemptionClaimFetch(ctx, claimPost("/acknowledge", claimBody))
      ).json(),
    ).toEqual({ status: "accepted" });
    expect(gated).toBeGreaterThanOrEqual(4);
  });

  it("rejects non-POST, unknown paths, malformed bodies, and non-finite nowMs", async () => {
    const ctx = claimMemoryCtx();
    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          new Request("https://do/claim", { method: "GET" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await handleExposureRedemptionClaimFetch(ctx, claimPost("/other", claimBody))).status,
    ).toBe(404);
    expect(
      (await handleExposureRedemptionClaimFetch(ctx, claimPost("/claim", { exposureId: "e1" })))
        .status,
    ).toBe(400);
    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          claimPost("/claim", { ...claimBody, nowMs: Number.NaN }),
        )
      ).status,
    ).toBe(400);
  });

  it("does not list the full keyspace on the claim hot path", async () => {
    const ctx = claimMemoryCtx();
    let listed = 0;
    (ctx.storage as unknown as { list: () => Promise<Map<string, unknown>> }).list = async () => {
      listed += 1;
      return new Map();
    };
    await handleExposureRedemptionClaimFetch(ctx, claimPost("/claim", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, claimPost("/markSealed", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, claimPost("/acknowledge", claimBody));
    expect(listed).toBe(0);
  });

  it("release clears pending so a later claim can acquire", async () => {
    const ctx = claimMemoryCtx();
    await handleExposureRedemptionClaimFetch(ctx, claimPost("/claim", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, claimPost("/release", claimBody));
    expect(
      await (
        await handleExposureRedemptionClaimFetch(
          ctx,
          claimPost("/claim", { ...claimBody, exposureId: "e2", nowMs: 2 }),
        )
      ).json(),
    ).toEqual({ status: "acquired" });
  });

  it("does not arm an alarm on pending claim; arms claim-TTL on seal", async () => {
    const ctx = claimMemoryCtx();
    const now = Date.now();
    await handleExposureRedemptionClaimFetch(
      ctx,
      claimPost("/claim", { ...claimBody, nowMs: now }),
    );
    expect(await ctx.storage.getAlarm()).toBeNull();

    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          claimPost("/markSealed", { ...claimBody, nowMs: now }),
        )
      ).status,
    ).toBe(200);
    const sealedAlarm = now + EXPOSURE_REDEMPTION_CLAIM_TTL_MS;
    expect(await ctx.storage.getAlarm()).toBe(sealedAlarm);

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
    await simulateClaimAlarm(ctx);
    expect(await ctx.storage.get("exposure:old")).toBeUndefined();
    expect(await ctx.storage.getAlarm()).toBe(nearer);
  });

  it("setExpiryAlarm never pushes an existing earlier alarm later", async () => {
    const ctx = claimMemoryCtx();
    const now = Date.now();
    const early = now + 5_000;
    await ctx.storage.setAlarm(early);

    await handleExposureRedemptionClaimFetch(
      ctx,
      claimPost("/claim", { ...claimBody, nowMs: now }),
    );
    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          claimPost("/markSealed", { ...claimBody, nowMs: now }),
        )
      ).status,
    ).toBe(200);

    // markSealed wants now+24h; monotonic guard must keep the nearer alarm.
    expect(await ctx.storage.getAlarm()).toBe(early);
    expect(early).toBeLessThan(now + EXPOSURE_REDEMPTION_CLAIM_TTL_MS);
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
