import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ID,
  ENVIRONMENT_ID,
  type FakeConvex,
  installed as installedAt,
  snapshotAt,
} from "../testing/fake-convex-test-helpers";
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

  it("leaves a fresh Entity unclaimed until the announced Run snapshot commits", async () => {
    const convex = installed(7);
    await announce(convex, 8);

    const first = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "once" });
    const retry = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "once" });

    expect(first).toMatchObject({ reason: "ERROR", errorCode: "PROVIDER_NOT_READY" });
    expect(retry).toEqual(first);
    expect(convex.rows("exposureOutbox")).toHaveLength(0);
    expect(convex.rows("evaluationClaims")).toHaveLength(0);
    expect(convex.rows("assignments")).toHaveLength(0);

    const next = snapshotAt(8);
    next.experiments = next.experiments.map((experiment) => ({
      ...experiment,
      liveRunId: "run_2",
    }));
    next.runs = next.runs.map((run) => ({ ...run, id: "run_2", configHash: "sha256:run-2" }));
    await commitSnapshotHandler(convex.ctx, { payload: JSON.stringify(next) });
    const fresh = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "once" });
    const replay = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "once" });
    expect(fresh.reason).toBe("SPLIT");
    expect(replay).toEqual(fresh);
    expect(convex.rows("exposureOutbox")).toEqual([
      expect.objectContaining({ runId: "run_2", variantName: fresh.variantName }),
    ]);
    expect(convex.rows("assignments")).toEqual([
      expect.objectContaining({ runId: "run_2", variant: fresh.variantName }),
    ]);
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

  it("continues serving an existing holdover during grace without another Exposure", async () => {
    const convex = installed(7);
    const first = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "before" });
    await announce(convex, 8);
    const held = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "during" });
    expect(held).toEqual({ value: first.value, variantName: first.variantName, reason: "STALE" });
    expect(convex.rows("assignments")).toHaveLength(1);
    expect(convex.rows("exposureOutbox")).toHaveLength(1);
  });

  it("allows a non-exposing Flag evaluation during grace", async () => {
    const convex = installed(7);
    const snapshot = snapshotAt(7);
    await commitSnapshotHandler(convex.ctx, {
      payload: JSON.stringify({
        ...snapshot,
        flags: snapshot.flags.map((flag) => ({ ...flag, experimentId: null })),
        experiments: [],
        runs: [],
      }),
    });
    await announce(convex, 8);
    const result = await evaluateHandler(convex.ctx, { ...args, idempotencyKey: "flag-only" });
    expect(result.reason).toBe("STALE");
    expect(convex.rows("assignments")).toHaveLength(0);
    expect(convex.rows("exposureOutbox")).toHaveLength(0);
  });
});

describe("Convex sync grace recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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

describe("Convex snapshot commit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects a reference-broken snapshot without touching held state or the deadline", async () => {
    const convex = installed(7);
    await announce(convex, 8);
    const held = structuredClone(convex.rows("snapshots"));
    const recoveryJobId = convex.integration().syncRecoveryJobId;
    const broken = { ...snapshotAt(8), runs: [] };

    await expect(
      commitSnapshotHandler(convex.ctx, { payload: JSON.stringify(broken) }),
    ).rejects.toThrow(/absent live Run/);

    expect(convex.rows("snapshots")).toEqual(held);
    expect(convex.integration().syncRecoveryJobId).toBe(recoveryJobId);
    expect(recoveryJobId).toBeDefined();
    await convex.advance(SYNC_DEADLINE_MS);
    expect(convex.integration().syncOverdueVersion).toBe(8);

    await expect(
      commitSnapshotHandler(convex.ctx, { payload: JSON.stringify(broken) }),
    ).rejects.toThrow(/absent live Run/);
    expect(convex.integration().syncOverdueVersion).toBe(8);
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
