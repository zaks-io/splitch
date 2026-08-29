import { assignmentKey } from "@splitch/contracts";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";
import { bundleOutboxAssignmentWorker } from "./holdover-write-outbox-miniflare-bundle";

/**
 * Miniflare boundary: real HoldoverWriteOutbox DO + production
 * `AssignmentStoreWriter` / `AssignmentStoreDurableObject` sources. Injects a
 * first KV put failure so completion cannot mean "DO HTTP 200 while KV is still
 * pending in waitUntil".
 */

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "v1:hash-entity-1",
  identityVersion: "v1",
  runId: "run-42",
  variant: "treatment",
} as const;

describe("HoldoverWriteOutboxDurableObject via Miniflare (real boundary)", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("owns retry after first KV write-through failure and becomes readable after alarm", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: true });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);

    const first = await coordinator.ensure(PUT);
    expect(first).toEqual({ status: "owned" });

    const key = assignmentKey(PUT.appId, PUT.idType, PUT.targetingKeyHash);
    const kvBefore = await mf.getKVNamespace("ASSIGNMENTS_KV");
    expect(await kvBefore.get(key)).toBeNull();

    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));
    const alarm = await stub.fetch("https://holdover-write-outbox.local/__test/alarm", {
      method: "POST",
    });
    expect(alarm.status).toBe(200);

    const status = await stub.fetch("https://holdover-write-outbox.local/status");
    expect(await status.json()).toEqual({ status: "empty" });

    const kvAfter = await mf.getKVNamespace("ASSIGNMENTS_KV");
    const raw = await kvAfter.get(key);
    expect(raw).toEqual(expect.any(String));
    expect(JSON.parse(raw as string)).toMatchObject({
      data: {
        [PUT.experimentId]: { runId: PUT.runId, variant: PUT.variant },
      },
    });
  });

  it("duplicate ensure after completion does not leave durable job rows", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: false });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));
    expect(await (await stub.fetch("https://holdover-write-outbox.local/status")).json()).toEqual({
      status: "empty",
    });
  });

  it("completed ensure means KV is already visible (HTTP 200 cannot precede KV)", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: false });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    const key = assignmentKey(PUT.appId, PUT.idType, PUT.targetingKeyHash);
    const kv = await mf.getKVNamespace("ASSIGNMENTS_KV");
    // Production AssignmentStoreWriter awaits write-through before HTTP 200.
    // A waitUntil regression would ack completed while this get is still null.
    expect(await kv.get(key)).toEqual(expect.any(String));
  });

  it("retains a real alarm for post-cutoff pending work and eventually runs it", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstKvPut: true });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    await expect(coordinator.ensure(PUT, { sourceCreatedAtMs: 10_000 })).resolves.toEqual({
      status: "owned",
    });
    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));

    await coordinator.purgeEntity(PUT, 9_999);

    const alarmState = await stub.fetch("https://holdover-write-outbox.local/__test/alarm-state");
    const { alarm } = (await alarmState.json()) as { alarm: number | null };
    expect(alarm).toEqual(expect.any(Number));
    expect(await (await stub.fetch("https://holdover-write-outbox.local/status")).json()).toEqual({
      jobs: [expect.objectContaining({ experimentId: PUT.experimentId, status: "pending" })],
    });

    await stub.fetch("https://holdover-write-outbox.local/__test/alarm", { method: "POST" });

    expect(await (await stub.fetch("https://holdover-write-outbox.local/status")).json()).toEqual({
      status: "empty",
    });
    const key = assignmentKey(PUT.appId, PUT.idType, PUT.targetingKeyHash);
    expect(await (await mf.getKVNamespace("ASSIGNMENTS_KV")).get(key)).toEqual(expect.any(String));
  });
});

async function miniflareWithOutboxAndAssignmentStore(options: {
  failFirstKvPut: boolean;
}): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleOutboxAssignmentWorker(options.failFirstKvPut),
    compatibilityDate: "2026-06-21",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    durableObjects: {
      ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObjectV2" },
      HOLDOVER_WRITE_OUTBOX: { className: "HoldoverWriteOutboxDurableObject" },
      HOLDOVER_WRITE_APP_INVENTORY: { className: "TestAppInventoryDurableObject" },
    },
  });
}
