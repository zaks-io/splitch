import { getFunctionName } from "convex/server";
import { vi } from "vitest";
import type { MutationCtx } from "../component/_generated/server";

export const APP_ID = "app_1";
export const ENVIRONMENT_ID = "environment_1";

type Row = Record<string, unknown> & { _id: string };
export type FakeConvex = ReturnType<typeof installed>;

// A transactional-enough Convex ctx: index equality filters, patch semantics where undefined
// removes a field, and a scheduler driven by Vitest fake timers.
export function installed(
  version: number,
  scheduled: Record<string, (ctx: MutationCtx, args: never) => Promise<unknown>>,
) {
  const tables = new Map<string, Row[]>();
  const jobs = new Map<string, { state: { kind: string } }>();
  const reads = new Set<string>();
  const writes: string[] = [];
  const running: Promise<unknown>[] = [];
  let nextId = 0;
  const rows = (table: string) => tables.get(table) ?? tables.set(table, []).get(table) ?? [];
  const find = (id: string) => [...tables.values()].flat().find((row) => row._id === id);

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

export function snapshotAt(environmentVersion: number) {
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
