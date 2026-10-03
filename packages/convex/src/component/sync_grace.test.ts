import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { canonicalJson, sha256Hex } from "./crypto";
import { evaluateHandler, peekHandler } from "./evaluation";
import { activateHandler, markSyncOverdueHandler, SYNC_DEADLINE_MS } from "./integration_recovery";
import { announceHandler, commitSnapshotHandler } from "./integration_sync";

const APP_ID = "app_1";
const ENVIRONMENT_ID = "environment_1";
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
});

function announce(convex: FakeConvex, environmentVersion: number) {
  return announceHandler(convex.ctx, {
    deliveryId: `delivery_${environmentVersion}`,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    environmentVersion,
  });
}

type Row = Record<string, unknown> & { _id: string };
type FakeConvex = ReturnType<typeof installed>;

// A transactional-enough Convex ctx: index equality filters, patch semantics where undefined
// removes a field, and a scheduler driven by Vitest fake timers.
function installed(version: number) {
  const tables = new Map<string, Row[]>();
  const jobs = new Map<string, { state: { kind: string } }>();
  const reads = new Set<string>();
  const writes: string[] = [];
  const running: Promise<unknown>[] = [];
  let nextId = 0;
  const rows = (table: string) => tables.get(table) ?? tables.set(table, []).get(table) ?? [];
  const find = (id: string) => [...tables.values()].flat().find((row) => row._id === id);
  const scheduled: Record<string, (ctx: MutationCtx, args: never) => Promise<unknown>> = {
    "integration_recovery:markSyncOverdue": markSyncOverdueHandler,
  };

  const db = {
    query(table: string) {
      let matched = rows(table);
      const builder = {
        withIndex(_index: string, apply?: (q: unknown) => unknown) {
          const filters: Array<[string, unknown]> = [];
          const range = {
            eq(field: string, value: unknown) {
              filters.push([field, value]);
              return range;
            },
          };
          apply?.(range);
          matched = matched.filter((row) =>
            filters.every(([field, value]) => row[field] === value),
          );
          return builder;
        },
        order: () => builder,
        async unique() {
          if (matched.length > 1) throw new Error(`unique() matched ${matched.length} rows`);
          for (const row of matched) reads.add(row._id);
          return matched[0] ?? null;
        },
        first: async () => builder.take(1).then((taken) => taken[0] ?? null),
        async take(count: number) {
          const taken = matched.slice(0, count);
          for (const row of taken) reads.add(row._id);
          return taken;
        },
      };
      return builder;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      const _id = `${table}_${++nextId}`;
      rows(table).push({ ...doc, _id });
      return _id;
    },
    async patch(id: string, fields: Record<string, unknown>) {
      const row = find(id);
      if (!row) throw new Error(`patch: missing ${id}`);
      for (const [key, value] of Object.entries(fields))
        if (value === undefined) delete row[key];
        else row[key] = value;
      writes.push(id);
    },
    async replace(id: string, doc: Record<string, unknown>) {
      const table = [...tables.values()].find((candidates) => candidates.some((r) => r._id === id));
      if (!table) throw new Error(`replace: missing ${id}`);
      table.splice(
        table.findIndex((r) => r._id === id),
        1,
        { ...doc, _id: id },
      );
      writes.push(id);
    },
    system: { get: async (_table: string, id: string) => jobs.get(id) ?? null },
    vars: { commitTs: 0 },
  };
  const scheduler = {
    async runAfter(delayMs: number, reference: never, jobArgs: never) {
      const id = `job_${++nextId}`;
      const job = { state: { kind: "pending" } };
      jobs.set(id, job);
      const handler = scheduled[getFunctionName(reference)];
      setTimeout(() => {
        if (job.state.kind !== "pending") return;
        job.state = { kind: "success" };
        if (handler) running.push(handler(ctx, jobArgs));
      }, delayMs);
      return id;
    },
    async cancel(id: string) {
      const job = jobs.get(id);
      if (job) job.state = { kind: "canceled" };
    },
  };
  const ctx = { db, scheduler } as unknown as MutationCtx;

  rows("integrations").push({
    _id: "integration_current",
    key: "current",
    installationId: "installation_1",
    componentIdentityKey: "identity-key",
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    announcedVersion: version,
    snapshotVersion: version,
    state: "active",
  });
  rows("snapshots").push({
    _id: "snapshot_current",
    key: "current",
    environmentVersion: version,
    payload: JSON.stringify(snapshotAt(version)),
  });

  return {
    ctx,
    reads,
    writes,
    rows,
    integration: () => rows("integrations")[0] as Row,
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
      await Promise.all(running.splice(0));
    },
  };
}

function snapshotAt(environmentVersion: number) {
  const variants = [
    { id: "control", name: "control", value: "control-value" },
    { id: "treatment", name: "treatment", value: "treatment-value" },
  ];
  return {
    schemaVersion: 1,
    environmentVersion,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    flags: [
      {
        id: "flag_1",
        key: "checkout",
        environmentId: ENVIRONMENT_ID,
        experimentId: "experiment_1",
        enabled: true,
        defaultVariantId: "control",
        variants,
        availableVariantNames: ["control", "treatment"],
        targetingRules: [],
        rollout: null,
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    ],
    experiments: [
      {
        id: "experiment_1",
        environmentId: ENVIRONMENT_ID,
        flagId: "flag_1",
        targetingKey: "userId",
        targetingKeyType: "user",
        status: "running",
        liveRunId: "run_1",
      },
    ],
    runs: [
      {
        id: "run_1",
        experimentId: "experiment_1",
        salt: "stable-salt",
        allocation: { control: 50, treatment: 50 },
        variantSet: variants,
        targetingRules: [],
        configHash: "sha256:run-1",
        startedAt: "2026-10-03T00:00:00.000Z",
      },
    ],
  };
}
