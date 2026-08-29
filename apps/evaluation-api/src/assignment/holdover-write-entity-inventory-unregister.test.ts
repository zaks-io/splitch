/**
 * Real Miniflare DO coverage: Entity outbox /delete unregisters App inventory
 * under blockConcurrencyWhile; a post-cutoff /ensure that serializes afterward
 * re-registers (SPL-346).
 */
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import { bundleHoldoverWriteInventoryAndOutboxWorker } from "./holdover-write-miniflare-bundle";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "v1:hash-entity-1",
  identityVersion: "v1",
  runId: "run-42",
  variant: "treatment",
} as const;

describe("Entity /delete inventory unregister via Miniflare DOs", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("privacy deletion removes inventory ref; post-cutoff ensure re-registers", async () => {
    mf = await miniflareWithInventoryAndOutbox();
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const inventoryNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_APP_INVENTORY",
    )) as unknown as HoldoverWriteAppInventoryNamespace;
    const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
    const outboxStub = outboxNs.get(
      outboxNs.idFromName(`${PUT.appId}:${PUT.idType}:${PUT.targetingKeyHash}`),
    );

    const ensureBefore = await outboxStub.fetch("https://holdover-write-outbox.local/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...PUT, sourceCreatedAtMs: 1_000 }),
    });
    expect(ensureBefore.ok).toBe(true);
    expect(await inventory.status(PUT.appId)).toMatchObject({
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });

    const deleteResponse = await outboxStub.fetch("https://holdover-write-outbox.local/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deleteBeforeTsMs: 1_500,
        appId: PUT.appId,
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
    });
    expect(deleteResponse.ok).toBe(true);
    expect((await inventory.status(PUT.appId)).entities).toEqual([]);

    const racingDelete = outboxStub.fetch("https://holdover-write-outbox.local/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deleteBeforeTsMs: 1_500,
        appId: PUT.appId,
        idType: PUT.idType,
        targetingKeyHash: PUT.targetingKeyHash,
      }),
    });
    const ensureAfter = outboxStub.fetch("https://holdover-write-outbox.local/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...PUT, sourceCreatedAtMs: 1_600 }),
    });
    const [deleteAfter, ensuredAfter] = await Promise.all([racingDelete, ensureAfter]);
    expect(deleteAfter.ok).toBe(true);
    expect(ensuredAfter.ok).toBe(true);
    expect(await inventory.status(PUT.appId)).toMatchObject({
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
  });
});

async function miniflareWithInventoryAndOutbox(): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleHoldoverWriteInventoryAndOutboxWorker(),
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
