import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import { miniflareWithInventoryAndOutbox } from "./holdover-write-app-inventory-miniflare-fixture";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { appHoldoverWriteSuppressKey, holdoverWriteOutboxName } from "./holdover-write-outbox-core";

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "hash-entity-1",
  runId: "run-42",
  variant: "treatment",
} as const;
const GENERATION_ID = "generation-A";

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

    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await inventory.markD1Deleted(PUT.appId, GENERATION_ID, 9_000);
    await inventory.finalizeDeletion(PUT.appId, GENERATION_ID, 9_000);

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

    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await inventory.markD1Deleted(PUT.appId, GENERATION_ID, 9_000);
    // Concurrent register + complete: DO blockConcurrencyWhile serializes them.
    // After suppress, register must return suppressed — never re-index post-complete.
    const [registerResult] = await Promise.all([
      inventory.registerEntity(PUT.appId, {
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
      inventory.finalizeDeletion(PUT.appId, GENERATION_ID, 9_000),
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

    await expect(inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000)).rejects.toThrow(
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

  it("recovers identity reset completion after cancellation committed before its marker", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 0 });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);

    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await expect(inventory.cancelDeletion(PUT.appId, GENERATION_ID)).resolves.toMatchObject({
      cancelled: true,
      done: true,
      sagaPhase: null,
    });

    const restartedClient = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    await expect(
      restartedClient.completeIdentityReset(PUT.appId, GENERATION_ID),
    ).resolves.toMatchObject({ cancelled: true, done: true, sagaPhase: null });
    await expect(
      restartedClient.completeIdentityReset(PUT.appId, GENERATION_ID),
    ).resolves.toMatchObject({ cancelled: true, done: true, sagaPhase: null });
    expect(await restartedClient.status(PUT.appId)).toMatchObject({
      suppressed: false,
      sagaPhase: null,
      entities: [],
    });
  });
});

describe("HoldoverWriteAppInventoryDurableObject deletion alarm recovery", () => {
  it("ignores a delayed stale cancel after a newer deletion generation prepares", async () => {
    mf = await miniflareWithInventoryAndOutbox({ registerFailsRemaining: 0 });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const nextGeneration = "generation-B";

    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await inventory.beginDeletion(PUT.appId, nextGeneration, 10_000);

    await expect(inventory.cancelDeletion(PUT.appId, GENERATION_ID)).resolves.toMatchObject({
      cancelled: false,
      done: true,
      sagaPhase: "prepared",
    });
    expect(await inventory.status(PUT.appId)).toMatchObject({
      generationId: nextGeneration,
      suppressed: true,
      sagaPhase: "prepared",
      deleteBeforeTsMs: 10_000,
    });
    const kv = await mf.getKVNamespace("ASSIGNMENTS_KV");
    expect(await kv.get(appHoldoverWriteSuppressKey(PUT.appId))).toBe("1");

    await inventory.markD1Deleted(PUT.appId, nextGeneration, 10_000);
    await inventory.finalizeDeletion(PUT.appId, nextGeneration, 10_000);
    expect(await inventory.status(PUT.appId)).toMatchObject({
      generationId: nextGeneration,
      suppressed: true,
      sagaPhase: "completed",
      deletionComplete: true,
    });
  });

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
    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await expect(inventory.cancelDeletion(PUT.appId, GENERATION_ID)).rejects.toThrow(/HTTP 400/u);
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toMatchObject({
      jobs: [expect.objectContaining({ experimentId: PUT.experimentId })],
    });

    await inventoryStub.fetch("https://inventory.local/__test/alarm", { method: "POST" });
    expect(await inventory.status(PUT.appId)).toMatchObject({ suppressed: false, sagaPhase: null });

    await outboxStub.fetch("https://outbox.local/__test/alarm", { method: "POST" });
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toMatchObject({
      jobs: [expect.objectContaining({ experimentId: PUT.experimentId })],
    });
    const staleRecheck = await (
      await outboxStub.fetch("https://outbox.local/__test/alarm-status")
    ).json<{ alarm: number | null; nowMs: number }>();
    expect(staleRecheck.alarm).not.toBeNull();
    expect(staleRecheck.alarm).toBeGreaterThan(staleRecheck.nowMs);
    await outboxStub.fetch("https://outbox.local/__test/alarm", { method: "POST" });
    expect(await (await outboxStub.fetch("https://outbox.local/status")).json()).toEqual({
      status: "empty",
    });
    expect(
      await (await outboxStub.fetch("https://outbox.local/__test/alarm-status")).json(),
    ).toMatchObject({ alarm: null });
  });
});

describe("HoldoverWriteAppInventoryDurableObject finalize alarm recovery", () => {
  it("recovers finalize when the d1_deleted phase write response is lost", async () => {
    mf = await miniflareWithInventoryAndOutbox({
      registerFailsRemaining: 0,
      markTransactionThrowsAfterCommitRemaining: 1,
    });
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const inventoryStub = inventoryNs.get(inventoryNs.idFromName(PUT.appId));

    await inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await expect(inventory.markD1Deleted(PUT.appId, GENERATION_ID, 9_000)).rejects.toThrow(
      /HTTP 400/u,
    );
    expect(await inventory.status(PUT.appId)).toMatchObject({ sagaPhase: "d1_deleted" });
    const secured = await (
      await inventoryStub.fetch("https://inventory.local/__test/alarm-status")
    ).json<{ alarm: number | null; nowMs: number }>();
    expect(secured.alarm).not.toBeNull();
    expect(secured.alarm).toBeGreaterThan(secured.nowMs);

    const recovered = await inventoryStub.fetch("https://inventory.local/__test/alarm", {
      method: "POST",
    });
    expect(recovered.ok).toBe(true);
    expect(await inventory.status(PUT.appId)).toMatchObject({
      sagaPhase: "completed",
      deletionComplete: true,
    });
  });
});
