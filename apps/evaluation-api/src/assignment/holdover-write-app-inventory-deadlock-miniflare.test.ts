import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import {
  miniflareWithInventoryAndOutbox,
  settlesWithin,
  waitForDeadlockBarrier,
} from "./holdover-write-app-inventory-miniflare-fixture";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { HOLDOVER_WRITE_MAX_ATTEMPTS, holdoverWriteOutboxName } from "./holdover-write-outbox-core";

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

describe("HoldoverWriteAppInventoryDurableObject two-DO races", () => {
  it("settles cancel racing an Entity ensure after KV clear", async () => {
    // The seeded job's retry alarm is due 1s after its failed put. The barrier
    // waits below can outlast that on a loaded runner, so a single seeded
    // failure lets the retry succeed and drain the outbox before the assertion.
    // Failing every attempt keeps the job pending for the whole test window.
    const runtime = await setup({
      pauseCancelAfterKvDelete: true,
      writerPutFailsRemaining: HOLDOVER_WRITE_MAX_ATTEMPTS,
    });
    await runtime.inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);

    const cancel = runtime.inventory.cancelDeletion(PUT.appId, GENERATION_ID);
    await waitForDeadlockBarrier(runtime.mf, (status) => status.cancelKvDeleteReached);
    const ensure = runtime.coordinator.ensure({ ...PUT, experimentId: "exp-racing" });
    await waitForDeadlockBarrier(runtime.mf, (status) => status.ensureRegisterAttempts >= 2);
    await runtime.mf.dispatchFetch("https://harness.local/__test/release-cancel-kv-delete", {
      method: "POST",
    });

    const [cancelResult, ensureResult] = await settlesWithin(Promise.all([cancel, ensure]), 2_000);
    expect(cancelResult).toMatchObject({ cancelled: true, done: true, sagaPhase: null });
    expect(ensureResult).toEqual({ status: "suppressed" });
    expect(await runtime.inventory.status(PUT.appId)).toMatchObject({
      suppressed: false,
      sagaPhase: null,
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
    expect(await outboxStatus(runtime.outboxNs)).toMatchObject({
      jobs: [expect.objectContaining({ experimentId: PUT.experimentId })],
    });
  });

  it("settles finalize racing an Entity ensure through a stale KV read", async () => {
    const runtime = await setup({
      pauseFinalizeAfterInventoryList: true,
      missingSuppressionReadsRemaining: 1,
    });
    await runtime.inventory.beginDeletion(PUT.appId, GENERATION_ID, 9_000);
    await runtime.inventory.markD1Deleted(PUT.appId, GENERATION_ID, 9_000);

    const finalize = runtime.inventory.finalizeDeletion(PUT.appId, GENERATION_ID, 9_000);
    await waitForDeadlockBarrier(runtime.mf, (status) => status.finalizeInventoryListReached);
    const ensure = runtime.coordinator.ensure({ ...PUT, experimentId: "exp-racing" });
    await waitForDeadlockBarrier(runtime.mf, (status) => status.ensureRegisterAttempts >= 2);
    await runtime.mf.dispatchFetch("https://harness.local/__test/release-finalize-inventory-list", {
      method: "POST",
    });

    const [, ensureResult] = await settlesWithin(Promise.all([finalize, ensure]), 2_000);
    expect(ensureResult).toEqual({ status: "suppressed" });
    expect(await runtime.inventory.status(PUT.appId)).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      sagaPhase: "completed",
      entities: [],
    });
    expect(await outboxStatus(runtime.outboxNs)).toEqual({ status: "empty" });
  });
});

async function setup(options: {
  pauseCancelAfterKvDelete?: boolean;
  pauseFinalizeAfterInventoryList?: boolean;
  missingSuppressionReadsRemaining?: number;
  writerPutFailsRemaining?: number;
}) {
  mf = await miniflareWithInventoryAndOutbox({
    registerFailsRemaining: 0,
    writerPutFailsRemaining: 1,
    ...options,
  });
  const inventoryNs = (await mf.getDurableObjectNamespace(
    "HOLDOVER_WRITE_APP_INVENTORY",
  )) as unknown as HoldoverWriteAppInventoryNamespace;
  const outboxNs = (await mf.getDurableObjectNamespace(
    "HOLDOVER_WRITE_OUTBOX",
  )) as unknown as HoldoverWriteOutboxNamespace;
  const inventory = new DurableHoldoverWriteAppInventoryClient(inventoryNs);
  const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
  await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "owned" });
  return { mf, inventory, coordinator, outboxNs };
}

async function outboxStatus(namespace: HoldoverWriteOutboxNamespace): Promise<unknown> {
  const stub = namespace.get(namespace.idFromName(holdoverWriteOutboxName(PUT)));
  return (await stub.fetch("https://outbox.local/status")).json();
}
