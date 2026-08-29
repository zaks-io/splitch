import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import { bundleHoldoverWriteInventoryAndOutboxWorker } from "./holdover-write-miniflare-bundle";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { HOLDOVER_WRITE_MAX_ATTEMPTS, holdoverWriteOutboxName } from "./holdover-write-outbox-core";

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "v1:hash-entity-1",
  identityVersion: "v1",
  runId: "run-42",
  variant: "treatment",
} as const;
const GENERATION_ID = "generation-A";

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

describe("HoldoverWriteAppInventoryDurableObject finalize alarm recovery", () => {
  it("atomically leaves both d1_deleted and its alarm uncommitted on transaction failure", async () => {
    const { inventory, inventoryStub } = await startFinalizeTest({
      markTransactionFailsBeforeCommitRemaining: 1,
    });

    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await expect(inventory.markD1Deleted(PUT.appId, GENERATION_ID, 9_000)).rejects.toThrow(
      /HTTP 400/u,
    );
    expect(await inventory.status(PUT.appId)).toMatchObject({
      generationId: GENERATION_ID,
      suppressed: true,
      sagaPhase: "prepared",
      deletionComplete: false,
    });
    const uncommitted = await (
      await inventoryStub.fetch("https://inventory.local/__test/alarm-status")
    ).json<{ alarm: number | null }>();
    expect(uncommitted.alarm).toBeNull();
    expect(
      await (await inventoryStub.fetch("https://inventory.local/__test/transaction-status")).json(),
    ).toEqual({ sagaPutObserved: true });
  });

  it("finishes Entity purge from the App alarm after a transient two-DO failure", async () => {
    const { coordinator, inventory, inventoryStub, outboxStub } = await startFinalizeTest({
      purgeFailsRemaining: 1,
      writerPutFailsRemaining: HOLDOVER_WRITE_MAX_ATTEMPTS * 2,
    });
    const poisonedPut = { ...PUT, experimentId: "exp-poisoned", runId: "run-poisoned" };
    const pendingPut = { ...PUT, experimentId: "exp-pending", runId: "run-pending" };

    await expect(coordinator.ensure(poisonedPut, { sourceCreatedAtMs: 10_000 })).resolves.toEqual({
      status: "owned",
    });
    for (let attempt = 1; attempt < HOLDOVER_WRITE_MAX_ATTEMPTS; attempt += 1) {
      await outboxStub.fetch("https://outbox.local/__test/alarm", { method: "POST" });
    }
    await expect(coordinator.ensure(pendingPut, { sourceCreatedAtMs: 11_000 })).resolves.toEqual({
      status: "owned",
    });
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toMatchObject({
      jobs: expect.arrayContaining([
        expect.objectContaining({ experimentId: poisonedPut.experimentId, status: "poisoned" }),
        expect.objectContaining({ experimentId: pendingPut.experimentId, status: "pending" }),
      ]),
    });

    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await inventory.markD1Deleted(PUT.appId, GENERATION_ID, 9_000);
    await expect(inventory.finalizeDeletion(PUT.appId, GENERATION_ID, 9_000)).rejects.toThrow(
      /HTTP 400/u,
    );
    const retryAlarm = await (
      await inventoryStub.fetch("https://inventory.local/__test/alarm-status")
    ).json<{ alarm: number | null; nowMs: number }>();
    expect(retryAlarm.alarm).not.toBeNull();
    expect(retryAlarm.alarm).toBeGreaterThan(retryAlarm.nowMs);
    expect(await inventory.status(PUT.appId)).toMatchObject({
      sagaPhase: "finalizing",
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toMatchObject({
      jobs: expect.arrayContaining([
        expect.objectContaining({ experimentId: poisonedPut.experimentId }),
        expect.objectContaining({ experimentId: pendingPut.experimentId }),
      ]),
    });

    const retry = await inventoryStub.fetch("https://inventory.local/__test/alarm", {
      method: "POST",
    });
    expect(retry.ok).toBe(true);
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toEqual({
      status: "empty",
    });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      sagaPhase: "completed",
      deletionComplete: true,
      entities: [],
    });
    expect(
      await (await inventoryStub.fetch("https://inventory.local/__test/alarm-status")).json(),
    ).toMatchObject({ alarm: null });
  });

  it("keeps a post-cutoff poisoned Entity inventoried until App finalize purges it", async () => {
    const { coordinator, inventory, outboxStub } = await startFinalizeTest({
      writerPutFailsRemaining: HOLDOVER_WRITE_MAX_ATTEMPTS,
    });
    await expect(coordinator.ensure(PUT, { sourceCreatedAtMs: 10_000 })).resolves.toEqual({
      status: "owned",
    });
    for (let attempt = 1; attempt < HOLDOVER_WRITE_MAX_ATTEMPTS; attempt += 1) {
      await outboxStub.fetch("https://outbox.local/__test/alarm", { method: "POST" });
    }
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toMatchObject({
      jobs: [expect.objectContaining({ status: "poisoned", attempt: HOLDOVER_WRITE_MAX_ATTEMPTS })],
    });

    const deletion = await outboxStub.fetch("https://outbox.local/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deleteBeforeTsMs: 9_999,
        appId: PUT.appId,
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
    });

    expect(await deletion.json()).toEqual({ ok: true, remainingJobs: true });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await inventory.markD1Deleted(PUT.appId, GENERATION_ID, 9_000);
    await inventory.finalizeDeletion(PUT.appId, GENERATION_ID, 9_000);
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toEqual({
      status: "empty",
    });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      sagaPhase: "completed",
      deletionComplete: true,
      entities: [],
    });
  });
});

async function startFinalizeTest(options: {
  purgeFailsRemaining?: number;
  writerPutFailsRemaining?: number;
  markTransactionFailsBeforeCommitRemaining?: number;
}) {
  mf = new Miniflare({
    modules: true,
    script: bundleHoldoverWriteInventoryAndOutboxWorker({
      registerFailsRemaining: 0,
      ...options,
    }),
    compatibilityDate: "2026-06-21",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    durableObjects: {
      ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObject" },
      HOLDOVER_WRITE_OUTBOX: { className: "HoldoverWriteOutboxDurableObject" },
      HOLDOVER_WRITE_APP_INVENTORY: { className: "HoldoverWriteAppInventoryDurableObject" },
    },
  });
  const inventoryNs = (await mf.getDurableObjectNamespace(
    "HOLDOVER_WRITE_APP_INVENTORY",
  )) as unknown as HoldoverWriteAppInventoryNamespace;
  const outboxNs = (await mf.getDurableObjectNamespace(
    "HOLDOVER_WRITE_OUTBOX",
  )) as unknown as HoldoverWriteOutboxNamespace;
  return {
    inventory: new DurableHoldoverWriteAppInventoryClient(inventoryNs),
    coordinator: new DurableHoldoverWriteCoordinator(outboxNs),
    inventoryStub: inventoryNs.get(inventoryNs.idFromName(PUT.appId)),
    outboxStub: outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT))),
  };
}
