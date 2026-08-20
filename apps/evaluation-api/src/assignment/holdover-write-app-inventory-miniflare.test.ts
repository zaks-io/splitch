import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { bundleHoldoverWriteInventoryAndOutboxWorker } from "./holdover-write-miniflare-bundle";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "hash-entity-1",
  runId: "run-42",
  variant: "treatment",
} as const;

describe("HoldoverWriteAppInventoryDurableObject via Miniflare", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

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
});

async function miniflareWithInventoryAndOutbox(options: {
  registerFailsRemaining: number;
}): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleHoldoverWriteInventoryAndOutboxWorker({
      registerFailsRemaining: options.registerFailsRemaining,
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
}
