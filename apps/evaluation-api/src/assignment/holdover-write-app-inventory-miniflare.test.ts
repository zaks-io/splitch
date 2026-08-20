import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { bundleHoldoverWriteInventoryAndOutboxWorker } from "./holdover-write-miniflare-bundle";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "hash-entity-1",
  runId: "run-42",
  variant: "treatment",
} as const;

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

describe("HoldoverWriteAppInventoryDurableObject via Miniflare", () => {
  it("retries App inventory registration after a transport failure until confirmed", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 1 });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);

    await expect(coordinator.ensure(PUT)).rejects.toThrow(/transport|register|failed|Error/i);
    expect((await inventory.status(PUT.appId)).entities).toEqual([]);

    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: false,
      deletionComplete: false,
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
  });

  it("refuses registration once App deletion completes (register-versus-complete)", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 0 });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);

    await inventory.beginDeletion(PUT.appId, 9_000);
    await inventory.completeDeletion(PUT.appId);

    await expect(
      inventory.registerEntity(PUT.appId, {
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
    ).resolves.toEqual({ status: "suppressed" });
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "suppressed" });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      entities: [],
    });
  });

  it("serializes register behind App deletion so complete cannot miss a late Entity", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 0 });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);

    await inventory.beginDeletion(PUT.appId, 9_000);
    // Concurrent register + complete: DO blockConcurrencyWhile serializes them.
    // After suppress, register must return suppressed — never re-index post-complete.
    const [registerResult] = await Promise.all([
      inventory.registerEntity(PUT.appId, {
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
      inventory.completeDeletion(PUT.appId),
    ]);
    expect(registerResult).toEqual({ status: "suppressed" });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      entities: [],
    });
  });

  it("recovers a preparing saga by alarm after an ambiguous KV freeze failure", async () => {
    mf = await miniflareWithInventoryAndOutbox({
      registerFailsRemaining: 0,
      suppressPutFailsRemaining: 1,
      cancelStatePutFailsRemaining: 1,
    });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const stub = inventoryNs.get(inventoryNs.idFromName(PUT.appId));

    await expect(inventory.beginDeletion(PUT.appId, 9_000)).rejects.toThrow(
      "app inventory /begin-deletion returned HTTP 400",
    );
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: true,
      sagaPhase: "preparing",
    });
    const kv = await mf.getKVNamespace("ASSIGNMENTS_KV");
    expect(await kv.get(appHoldoverWriteSuppressKey(PUT.appId))).toBe("1");

    const alarm = await stub.fetch("https://holdover-write-app-inventory.local/__test/alarm", {
      method: "POST",
    });
    expect(alarm.ok).toBe(true);
    expect(await inventory.status(PUT.appId)).toMatchObject({
      suppressed: false,
      sagaPhase: null,
    });
    expect(await kv.get(appHoldoverWriteSuppressKey(PUT.appId))).toBeNull();
  });
});

describe("HoldoverWriteAppInventoryDurableObject deletion alarm recovery", () => {
  it("keeps accepted work alarm-recheckable across KV delete failure and stale visibility", async () => {
    mf = await miniflareWithInventoryAndOutbox({
      registerFailsRemaining: 0,
      writerPutFailsRemaining: 1,
      cancelKvDeleteFailsRemaining: 1,
      staleSuppressionReadsRemaining: 1,
    });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    const inventoryStub = inventoryNs.get(inventoryNs.idFromName(PUT.appId));
    const outboxStub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));

    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "owned" });
    await inventory.beginDeletion(PUT.appId, 9_000);
    await expect(inventory.cancelDeletion(PUT.appId)).rejects.toThrow(/HTTP 400/u);
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toMatchObject({
      jobs: [expect.objectContaining({ experimentId: PUT.experimentId })],
    });

    await inventoryStub.fetch("https://inventory.local/__test/alarm", { method: "POST" });
    expect(await inventory.status(PUT.appId)).toMatchObject({ suppressed: false, sagaPhase: null });

    await outboxStub.fetch("https://outbox.local/__test/alarm", { method: "POST" });
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toMatchObject({
      jobs: [expect.objectContaining({ experimentId: PUT.experimentId })],
    });
    await outboxStub.fetch("https://outbox.local/__test/alarm", { method: "POST" });
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toEqual({
      status: "empty",
    });
  });

  it("finishes Entity purge from the App alarm after a transient two-DO failure", async () => {
    mf = await miniflareWithInventoryAndOutbox({
      registerFailsRemaining: 0,
      purgeFailsRemaining: 1,
    });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    const inventoryStub = inventoryNs.get(inventoryNs.idFromName(PUT.appId));

    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    await inventory.beginDeletion(PUT.appId, 9_000);
    await inventory.markD1Deleted(PUT.appId, 9_000);
    const failedAlarm = await inventoryStub.fetch("https://inventory.local/__test/alarm", {
      method: "POST",
    });
    expect(failedAlarm.status).toBe(503);
    expect(await failedAlarm.json()).toMatchObject({
      error: expect.stringMatching(/purge|transport/u),
    });
    const retry = await inventoryStub.fetch("https://inventory.local/__test/alarm", {
      method: "POST",
    });
    expect(retry.ok).toBe(true);
    expect(await inventory.status(PUT.appId)).toMatchObject({
      sagaPhase: "completed",
      deletionComplete: true,
      entities: [],
    });
  });
});

async function miniflareWithInventoryAndOutbox(options: {
  registerFailsRemaining: number;
  suppressPutFailsRemaining?: number;
  cancelStatePutFailsRemaining?: number;
  cancelKvDeleteFailsRemaining?: number;
  staleSuppressionReadsRemaining?: number;
  writerPutFailsRemaining?: number;
  purgeFailsRemaining?: number;
}): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleHoldoverWriteInventoryAndOutboxWorker(options),
    compatibilityDate: "2026-06-21",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    durableObjects: {
      ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObject" },
      HOLDOVER_WRITE_OUTBOX: { className: "HoldoverWriteOutboxDurableObject" },
      HOLDOVER_WRITE_APP_INVENTORY: { className: "HoldoverWriteAppInventoryDurableObject" },
    },
  });
}
