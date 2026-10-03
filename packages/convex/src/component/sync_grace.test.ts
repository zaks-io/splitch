import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ID,
  ENVIRONMENT_ID,
  type FakeConvex,
  installed as installedAt,
  snapshotAt,
} from "../testing/fake-convex-test-helpers";
import { canonicalJson, sha256Hex } from "./crypto";
import { evaluateHandler, peekHandler } from "./evaluation";
import { activateHandler, markSyncOverdueHandler, SYNC_DEADLINE_MS } from "./integration_recovery";
import { announceHandler, commitSnapshotHandler } from "./integration_sync";

const installed = (version: number) =>
  installedAt(version, { "integration_recovery:markSyncOverdue": markSyncOverdueHandler });
const args = {
  flagKey: "checkout",
  context: { targetingKey: "entity_1", idType: "user", attributes: {} },
  defaultValue: "fallback",
};

describe("Convex sync grace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves the held snapshot's Variant as STALE while the pull is in flight", async () => {
    const convex = installed(7);
    const current = await peekHandler(convex.ctx, args);
    await announce(convex, 8);

    const stale = await peekHandler(convex.ctx, args);

    expect(current.reason).toBe("SPLIT");
    expect(stale).toEqual({
      value: current.value,
      variantName: current.variantName,
      reason: "STALE",
    });
  });

  it("persists one Exposure from the held Run across idempotent evaluate retries", async () => {
    const convex = installed(7);
    await announce(convex, 8);

    const first = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "once" });
    const retry = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "once" });

    expect(first.reason).toBe("STALE");
    expect(retry).toEqual(first);
    const outbox = convex.rows("exposureOutbox");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ runId: "run_1", variantName: first.variantName });
    const heldFingerprint = await sha256Hex(
      canonicalJson({
        flagKey: args.flagKey,
        context: args.context,
        defaultValue: args.defaultValue,
        snapshotVersion: 7,
      }),
    );
    expect(convex.rows("evaluationClaims")).toEqual([
      expect.objectContaining({ idempotencyKey: "once", fingerprint: heldFingerprint }),
    ]);

    await convex.advance(SYNC_DEADLINE_MS);
    const overdueRetry = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "once" });
    expect(overdueRetry).toEqual(first);
    expect(convex.rows("exposureOutbox")).toHaveLength(1);
  });

  it("fails loud with the Default Variant once the deadline passes behind", async () => {
    const convex = installed(7);
    await announce(convex, 8);

    await convex.advance(SYNC_DEADLINE_MS - 1);
    expect((await peekHandler(convex.ctx, args)).reason).toBe("STALE");
    await convex.advance(1);

    expect(convex.integration().syncOverdueVersion).toBe(8);
    expect(await peekHandler(convex.ctx, args)).toEqual({
      value: "fallback",
      variantName: null,
      reason: "ERROR",
      errorCode: "PROVIDER_NOT_READY",
      errorMessage: expect.stringMatching(/snapshot 7 .* announced version 8/),
    });
    expect(await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "late" })).toMatchObject({
      value: "fallback",
      reason: "ERROR",
    });
    expect(convex.rows("evaluationClaims")).toHaveLength(0);
    expect(convex.rows("exposureOutbox")).toHaveLength(0);
  });

  it("keeps the deadline a no-op when the snapshot commits in time", async () => {
    const convex = installed(7);
    await announce(convex, 8);
    await commitSnapshotHandler(convex.ctx, { payload: JSON.stringify(snapshotAt(8)) });

    await convex.advance(SYNC_DEADLINE_MS);

    expect(convex.integration().syncOverdueVersion).toBeUndefined();
    expect((await peekHandler(convex.ctx, args)).reason).toBe("SPLIT");
  });

  it("does not reopen the grace for a newer announcement while overdue", async () => {
    const convex = installed(7);
    await announce(convex, 8);
    await convex.advance(SYNC_DEADLINE_MS);
    await announce(convex, 9);

    expect((await peekHandler(convex.ctx, args)).reason).toBe("ERROR");
    await convex.advance(SYNC_DEADLINE_MS);
    expect(convex.integration().syncOverdueVersion).toBe(8);

    await commitSnapshotHandler(convex.ctx, { payload: JSON.stringify(snapshotAt(9)) });

    expect(convex.integration().syncOverdueVersion).toBeUndefined();
    expect((await peekHandler(convex.ctx, args)).reason).toBe("SPLIT");
  });

  it("ends the grace through a write to a row every query reads, never the clock", async () => {
    const convex = installed(7);
    await announce(convex, 8);
    const now = vi.spyOn(Date, "now");
    convex.reads.clear();
    await peekHandler(convex.ctx, args);
    expect(now).not.toHaveBeenCalled();
    const queryReadSet = new Set(convex.reads);

    await convex.advance(SYNC_DEADLINE_MS);

    expect(convex.writes).toContain(convex.integration()._id);
    expect(queryReadSet).toContain(convex.integration()._id);
  });

  it("seeds the deadline on activation when the snapshot is behind", async () => {
    const convex = installed(7);
    await activateHandler(convex.ctx, {
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      environmentVersion: 8,
    });

    await convex.advance(SYNC_DEADLINE_MS);

    expect(convex.integration().syncOverdueVersion).toBe(8);
  });

  it("labels a pre-announcement replay STALE without a second Exposure", async () => {
    const convex = installed(7);
    const first = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "early" });
    await announce(convex, 8);

    const replay = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "early" });

    expect(first.reason).toBe("SPLIT");
    expect(replay).toEqual({ value: first.value, variantName: first.variantName, reason: "STALE" });
    expect(convex.rows("exposureOutbox")).toHaveLength(1);
  });

  it("ignores a deadline left behind by an uninstalled installation", async () => {
    const convex = installed(7);
    await announce(convex, 8);

    await markSyncOverdueHandler(convex.ctx, {
      installationId: "uninstalled_installation",
      environmentVersion: 8,
    });

    expect(convex.integration().syncOverdueVersion).toBeUndefined();
  });
});

function announce(convex: FakeConvex, environmentVersion: number) {
  return announceHandler(convex.ctx, {
    deliveryId: `delivery_${environmentVersion}`,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    environmentVersion,
  });
}
