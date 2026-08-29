import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeAppIdentityReset, purgeAppIdentityAssignments } from "./app-identity-reset";
import { assignmentWriterName } from "./assignment/assignment-store";
import type { HoldoverWriteAppInventoryNamespace } from "./assignment/holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./assignment/holdover-write-app-inventory-client";
import { bundleHoldoverWriteInventoryAndOutboxWorker } from "./assignment/holdover-write-miniflare-bundle";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./assignment/holdover-write-outbox";
import { holdoverWriteOutboxName } from "./assignment/holdover-write-outbox-core";
import type { AssignmentWriterNamespace } from "./assignment/kv-assignment-store";
import { KvAssignmentStore } from "./assignment/kv-assignment-store";
import type { EvaluationApiEnv } from "./env";

const APP_ID = "app-A";
const RESET_ID = "reset-1";
const PUT_A = {
  appId: APP_ID,
  experimentId: "exp-a",
  idType: "user",
  targetingKeyHash: "v1:hash-a",
  identityVersion: "v1",
  runId: "run-a",
  sourceCreatedAtMs: 8_000,
  variant: "control",
} as const;
const PUT_B = {
  ...PUT_A,
  experimentId: "exp-b",
  idType: "device",
  targetingKeyHash: "v1:hash-b",
  runId: "run-b",
  variant: "treatment",
} as const;
const PUT_C = {
  ...PUT_A,
  experimentId: "exp-c",
  idType: "account",
  targetingKeyHash: "v1:hash-c",
  runId: "run-c",
} as const;
const FUTURE_PUT = {
  ...PUT_A,
  experimentId: "exp-future",
  sourceCreatedAtMs: 10_000,
} as const;

let mf: Miniflare | undefined;
let persistenceRoot: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await mf?.dispose();
  mf = undefined;
  if (persistenceRoot) await rm(persistenceRoot, { recursive: true, force: true });
  persistenceRoot = undefined;
});

describe("App identity reset with production Durable Objects", () => {
  it("unconditionally resets future-skew writer and outbox state while Entity delete preserves it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    persistenceRoot = await mkdtemp(join(tmpdir(), "splitch-app-identity-reset-future-"));
    mf = await startMiniflare(persistenceRoot, 0, 1);
    const runtime = await bindings(mf);
    const coordinator = new DurableHoldoverWriteCoordinator(runtime.outboxes);

    await expect(
      coordinator.ensure(FUTURE_PUT, { sourceCreatedAtMs: FUTURE_PUT.sourceCreatedAtMs }),
    ).resolves.toEqual({ status: "owned" });
    const writer = runtime.writers.get(
      runtime.writers.idFromName(assignmentWriterName(FUTURE_PUT)),
    );
    const outbox = runtime.outboxes.get(
      runtime.outboxes.idFromName(holdoverWriteOutboxName(FUTURE_PUT)),
    );

    const entityWriterDelete = await writer.fetch("https://assignment-store.local/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...FUTURE_PUT, deleteBeforeTsMs: 9_000 }),
    });
    expect(entityWriterDelete.ok).toBe(true);
    const entityOutboxDelete = await outbox.fetch("https://holdover-write-outbox.local/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...FUTURE_PUT, deleteBeforeTsMs: 9_000 }),
    });
    await expect(entityOutboxDelete.json()).resolves.toMatchObject({ remainingJobs: true });
    await expect(
      (await writer.fetch("https://assignment-store.local/export")).json(),
    ).resolves.toMatchObject({ assignments: { "exp-future": expect.any(Object) } });
    await expect(
      (await outbox.fetch("https://holdover-write-outbox.local/export")).json(),
    ).resolves.toMatchObject({ jobs: [expect.objectContaining({ createdAtMs: 10_000 })] });

    await expect(
      purgeAppIdentityAssignments(runtime.env, APP_ID, RESET_ID, ["v1"]),
    ).resolves.toContain("durable_inventory=empty");
    await expect(
      (await writer.fetch("https://assignment-store.local/export")).json(),
    ).resolves.toMatchObject({ assignments: {} });
    await expect(
      (await outbox.fetch("https://holdover-write-outbox.local/export")).json(),
    ).resolves.toMatchObject({ jobs: [] });
    await expect(
      completeAppIdentityReset(runtime.env, APP_ID, RESET_ID, "app-v2"),
    ).resolves.toBeUndefined();
    await expect(
      coordinator.ensure(FUTURE_PUT, { sourceCreatedAtMs: FUTURE_PUT.sourceCreatedAtMs }),
    ).resolves.toEqual({ status: "suppressed" });
  });

  it("resumes writer-first multi-Entity purge after a DO restart without old-hash resurrection", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    persistenceRoot = await mkdtemp(join(tmpdir(), "splitch-app-identity-reset-"));
    mf = await startMiniflare(persistenceRoot, 1);
    const first = await bindings(mf);
    const coordinator = new DurableHoldoverWriteCoordinator(first.outboxes);
    const directStore = new KvAssignmentStore(
      first.kv,
      first.writers,
      {} as never,
      undefined,
      first.inventoryNamespace,
    );
    await expect(directStore.putHashed(PUT_C)).resolves.toMatchObject({ status: "stored" });
    await expect(coordinator.ensure(PUT_A, { sourceCreatedAtMs: 8_000 })).resolves.toEqual({
      status: "completed",
    });
    await expect(coordinator.ensure(PUT_B, { sourceCreatedAtMs: 8_100 })).resolves.toEqual({
      status: "completed",
    });

    await expect(purgeAppIdentityAssignments(first.env, APP_ID, RESET_ID, ["v1"])).rejects.toThrow(
      /outbox purge returned HTTP 503/u,
    );
    await expect(first.inventory.status(APP_ID)).resolves.toMatchObject({
      generationId: RESET_ID,
      suppressed: true,
      sagaPhase: "prepared",
      entities: expect.arrayContaining([
        { idType: PUT_A.idType, targetingKeyHash: PUT_A.targetingKeyHash },
        { idType: PUT_B.idType, targetingKeyHash: PUT_B.targetingKeyHash },
        { idType: PUT_C.idType, targetingKeyHash: PUT_C.targetingKeyHash },
      ]),
    });

    await mf.dispose();
    mf = await startMiniflare(persistenceRoot, 0);
    const restarted = await bindings(mf);
    const assignmentStore = new KvAssignmentStore(restarted.kv, restarted.writers, {} as never);
    const oldHashRetries = await Promise.allSettled([
      assignmentStore.putHashed(PUT_A),
      assignmentStore.putHashed(PUT_B),
      assignmentStore.putHashed(PUT_C),
    ]);
    const tombstoned = oldHashRetries.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(tombstoned).toHaveLength(1);
    expect(String(tombstoned[0]?.reason)).toMatch(/App identity generation was reset/u);

    await expect(
      purgeAppIdentityAssignments(restarted.env, APP_ID, RESET_ID, ["v1"]),
    ).resolves.toBe("evaluation-assignments:kv=0;durable_inventory=empty;durable_objects=6");
    await expect(restarted.inventory.status(APP_ID)).resolves.toMatchObject({
      generationId: RESET_ID,
      suppressed: true,
      sagaPhase: "prepared",
      entities: [],
    });

    await expect(
      completeAppIdentityReset(restarted.env, APP_ID, RESET_ID, "app-v2"),
    ).resolves.toBeUndefined();
    await expect(restarted.inventory.status(APP_ID)).resolves.toMatchObject({
      generationId: null,
      suppressed: false,
      sagaPhase: null,
      entities: [],
    });
    const replacementStore = new KvAssignmentStore(
      restarted.kv,
      restarted.writers,
      {} as never,
      undefined,
      restarted.inventoryNamespace,
    );
    await expect(
      replacementStore.putHashed({
        ...PUT_C,
        experimentId: "exp-after-reset",
        targetingKeyHash: "app-v2:hash-c",
        identityVersion: "app-v2",
        sourceCreatedAtMs: 9_001,
      }),
    ).resolves.toMatchObject({ status: "stored" });
    await expect(
      replacementStore.putHashed({ ...PUT_C, experimentId: "exp-stale-retry" }),
    ).rejects.toThrow(/generation changed|returned HTTP 409/u);
  });
});

async function startMiniflare(
  root: string,
  outboxDeleteFailsRemaining: number,
  writerPutFailsRemaining = 0,
): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleHoldoverWriteInventoryAndOutboxWorker({
      purgeFailsRemaining: outboxDeleteFailsRemaining,
      writerPutFailsRemaining,
    }),
    compatibilityDate: "2026-06-21",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    kvPersist: join(root, "kv"),
    durableObjectsPersist: join(root, "durable-objects"),
    durableObjects: {
      ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObjectV2" },
      HOLDOVER_WRITE_OUTBOX: { className: "HoldoverWriteOutboxDurableObject" },
      HOLDOVER_WRITE_APP_INVENTORY: { className: "HoldoverWriteAppInventoryDurableObject" },
    },
  });
}

async function bindings(runtime: Miniflare) {
  const kv = (await runtime.getKVNamespace("ASSIGNMENTS_KV")) as unknown as KVNamespace;
  const writers = (await runtime.getDurableObjectNamespace(
    "ASSIGNMENT_STORE_WRITER",
  )) as unknown as AssignmentWriterNamespace;
  const outboxes = (await runtime.getDurableObjectNamespace(
    "HOLDOVER_WRITE_OUTBOX",
  )) as unknown as HoldoverWriteOutboxNamespace;
  const inventoryNamespace = (await runtime.getDurableObjectNamespace(
    "HOLDOVER_WRITE_APP_INVENTORY",
  )) as unknown as HoldoverWriteAppInventoryNamespace;
  return {
    kv,
    writers,
    outboxes,
    inventory: new DurableHoldoverWriteAppInventoryClient(inventoryNamespace),
    inventoryNamespace,
    env: {
      ASSIGNMENTS_KV: kv,
      ASSIGNMENT_STORE_WRITER: writers,
      HOLDOVER_WRITE_OUTBOX: outboxes,
      HOLDOVER_WRITE_APP_INVENTORY: inventoryNamespace,
    } as unknown as EvaluationApiEnv,
  };
}
