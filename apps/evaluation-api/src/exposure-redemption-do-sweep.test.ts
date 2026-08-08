import { describe, expect, it } from "vitest";
import { EXPOSURE_REDEMPTION_CLAIM_TTL_MS } from "./exposure-redemption-claim-core";
import {
  EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE,
  handleExposureRedemptionClaimFetch,
  runExposureRedemptionClaimAlarm,
} from "./exposure-redemption-do-handler";
import {
  claimMemoryCtx,
  claimPost,
  putSealedExposure,
  simulateClaimAlarm,
} from "./exposure-redemption-do-test-fixtures";

describe("ExposureRedemptionClaim alarm sweep paging", () => {
  it("bounds each alarm sweep page and re-arms immediately to continue", async () => {
    const ctx = claimMemoryCtx();
    const now = Date.now();
    const total = EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE + 40;
    for (let i = 0; i < total; i += 1) {
      await putSealedExposure(ctx, `exp-${String(i).padStart(4, "0")}`, now - 1);
    }
    const beforeFirst = Date.now();
    await simulateClaimAlarm(ctx);
    const afterFirst = Date.now();
    expect(ctx.listCalls[0]?.size).toBe(EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE);
    const midAlarm = await ctx.storage.getAlarm();
    expect(midAlarm).toBeGreaterThanOrEqual(beforeFirst);
    expect(midAlarm).toBeLessThanOrEqual(afterFirst);

    await simulateClaimAlarm(ctx);
    expect(ctx.listCalls[1]?.size).toBeLessThanOrEqual(EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE);
    expect(await ctx.storage.get(`exposure:exp-0000`)).toBeUndefined();
    expect(
      await ctx.storage.get(`exposure:exp-${String(total - 1).padStart(4, "0")}`),
    ).toBeUndefined();
    expect(await ctx.storage.getAlarm()).toBeNull();
  });

  it("re-arms and advances startAfter when the first page is entirely live", async () => {
    const ctx = claimMemoryCtx();
    const now = Date.now();
    const liveExpiry = now + EXPOSURE_REDEMPTION_CLAIM_TTL_MS;
    for (let i = 0; i < EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE; i += 1) {
      await putSealedExposure(ctx, `live-${String(i).padStart(4, "0")}`, liveExpiry);
    }
    await putSealedExposure(ctx, `z-expired`, now - 1);

    const beforeFirst = Date.now();
    await simulateClaimAlarm(ctx);
    const afterFirst = Date.now();
    expect(ctx.listCalls[0]?.size).toBe(EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE);
    expect(ctx.listCalls[0]?.startAfter).toBeUndefined();
    expect(await ctx.storage.get("exposure:z-expired")).toBeDefined();
    const continueAlarm = await ctx.storage.getAlarm();
    expect(continueAlarm).toBeGreaterThanOrEqual(beforeFirst);
    expect(continueAlarm).toBeLessThanOrEqual(afterFirst);

    await simulateClaimAlarm(ctx);
    expect(ctx.listCalls[1]?.startAfter).toBe(
      `exposure:live-${String(EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE - 1).padStart(4, "0")}`,
    );
    expect(await ctx.storage.get("exposure:z-expired")).toBeUndefined();
    expect(await ctx.storage.get("exposure:live-0000")).toBeDefined();
    expect(await ctx.storage.getAlarm()).toBe(liveExpiry);
  });

  it("does not wipe a seal-armed alarm when a later sweep page finds no nextExpiry", async () => {
    const ctx = claimMemoryCtx();
    const now = Date.now();
    // Fill past one page with expired exposure+ticket pairs so the cursor lands
    // among ticket: keys. A seal whose keys sort before that cursor is invisible
    // to later pages — nextExpiry stays null and must not deleteAlarm().
    for (let i = 0; i < 180; i += 1) {
      const id = `exp-${String(i).padStart(4, "0")}`;
      await ctx.storage.put(`exposure:${id}`, {
        ticketFingerprint: `m-${String(i).padStart(4, "0")}`,
        delivery: "sealed",
        expiresAt: now - 1,
      });
      await ctx.storage.put(`ticket:m-${String(i).padStart(4, "0")}`, {
        ownerExposureId: id,
        delivery: "sealed",
        expiresAt: now - 1,
      });
    }
    await simulateClaimAlarm(ctx);
    expect(ctx.listCalls[0]?.size).toBe(EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE);
    expect(ctx.listCalls[0]?.keys.at(-1)?.startsWith("ticket:")).toBe(true);

    await ctx.storage.deleteAlarm();
    const sealNow = Date.now();
    await handleExposureRedemptionClaimFetch(
      ctx,
      claimPost("/claim", {
        exposureId: "aaa-seal",
        ticketFingerprint: "a-seal",
        nowMs: sealNow,
      }),
    );
    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          claimPost("/markSealed", {
            exposureId: "aaa-seal",
            ticketFingerprint: "a-seal",
            nowMs: sealNow,
          }),
        )
      ).status,
    ).toBe(200);
    const sealedAlarm = sealNow + EXPOSURE_REDEMPTION_CLAIM_TTL_MS;
    expect(await ctx.storage.getAlarm()).toBe(sealedAlarm);
    expect(`exposure:aaa-seal` < (ctx.listCalls[0]?.keys.at(-1) ?? "")).toBe(true);
    expect(`ticket:a-seal` < (ctx.listCalls[0]?.keys.at(-1) ?? "")).toBe(true);

    await runExposureRedemptionClaimAlarm(ctx.storage);
    expect(await ctx.storage.getAlarm()).toBe(sealedAlarm);
    expect(await ctx.storage.get("exposure:aaa-seal")).toBeDefined();
  });

  it("drains mixed-case and punctuation exposureIds under byte-order paging", async () => {
    const ctx = claimMemoryCtx();
    const now = Date.now();
    const ids = [
      ...Array.from({ length: 120 }, (_, i) => `A-${String(i).padStart(3, "0")}`),
      ...Array.from({ length: 120 }, (_, i) => `_x-${String(i).padStart(3, "0")}`),
      ...Array.from({ length: 160 }, (_, i) => `a-${String(i).padStart(3, "0")}`),
    ];
    expect(ids.length).toBeGreaterThan(EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE);
    for (const id of ids) await putSealedExposure(ctx, id, now - 1);

    const byteOrder = ids
      .map((id) => `exposure:${id}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const localeOrder = [...byteOrder].sort((a, b) => a.localeCompare(b));
    expect(byteOrder).not.toEqual(localeOrder);

    await simulateClaimAlarm(ctx);
    expect(ctx.listCalls[0]?.keys).toEqual(byteOrder.slice(0, EXPOSURE_REDEMPTION_SWEEP_PAGE_SIZE));

    for (let tick = 0; tick < 8; tick += 1) {
      await simulateClaimAlarm(ctx);
      const remaining = (
        await Promise.all(ids.map((id) => ctx.storage.get(`exposure:${id}`)))
      ).filter((v) => v !== undefined);
      if (remaining.length === 0) break;
    }

    for (const id of ids) {
      expect(await ctx.storage.get(`exposure:${id}`)).toBeUndefined();
    }
  });
});
