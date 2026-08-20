import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import {
  miniflareWithInventoryAndOutbox,
  waitForDeadlockBarrier,
} from "./holdover-write-app-inventory-miniflare-fixture";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";

const APP_ID = "app-alarm-generation";
const GENERATION_A = "generation-A";
const GENERATION_B = "generation-B";

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

describe("App deletion alarm generation snapshots", () => {
  it("cannot cancel a newer prepared generation from a stale cancel snapshot", async () => {
    const runtime = await setup({
      pauseCancelAlarmAfterSnapshot: true,
      cancelKvDeleteFailsRemaining: 1,
    });
    await runtime.inventory.beginDeletion(APP_ID, GENERATION_A, 9_000);
    await expect(runtime.inventory.cancelDeletion(APP_ID, GENERATION_A)).rejects.toThrow(/400/u);

    const staleAlarm = runAlarm(runtime.stub);
    await waitForDeadlockBarrier(runtime.mf, (status) => status.cancelAlarmSnapshotReached);
    await expect(runtime.inventory.cancelDeletion(APP_ID, GENERATION_A)).resolves.toMatchObject({
      cancelled: true,
      done: true,
    });
    await runtime.inventory.beginDeletion(APP_ID, GENERATION_B, 10_000);
    await release(runtime.mf, "/__test/release-cancel-alarm-snapshot");

    expect(await (await staleAlarm).json()).toEqual({ ok: true });
    expect(await runtime.inventory.status(APP_ID)).toMatchObject({
      generationId: GENERATION_B,
      suppressed: true,
      sagaPhase: "prepared",
      deleteBeforeTsMs: 10_000,
    });
    const kv = await runtime.mf.getKVNamespace("ASSIGNMENTS_KV");
    expect(await kv.get(appHoldoverWriteSuppressKey(APP_ID))).toBe("1");
  });

  it("cannot delete a finalize alarm created after a prepared snapshot", async () => {
    const runtime = await setup({ pausePreparedAlarmAfterSnapshot: true });
    await runtime.inventory.beginDeletion(APP_ID, GENERATION_A, 9_000);

    const staleAlarm = runAlarm(runtime.stub);
    await waitForDeadlockBarrier(runtime.mf, (status) => status.preparedAlarmSnapshotReached);
    await runtime.inventory.markD1Deleted(APP_ID, GENERATION_A, 9_000);
    await release(runtime.mf, "/__test/release-prepared-alarm-snapshot");

    expect(await (await staleAlarm).json()).toEqual({ ok: true });
    const secured = await alarmStatus(runtime.stub);
    expect(secured.alarm).not.toBeNull();
    expect(secured.alarm).toBeGreaterThan(secured.nowMs);

    expect((await runAlarm(runtime.stub)).ok).toBe(true);
    expect(await runtime.inventory.status(APP_ID)).toMatchObject({
      generationId: GENERATION_A,
      sagaPhase: "completed",
      deletionComplete: true,
    });
  });
});

async function setup(options: {
  pauseCancelAlarmAfterSnapshot?: boolean;
  pausePreparedAlarmAfterSnapshot?: boolean;
  cancelKvDeleteFailsRemaining?: number;
}) {
  mf = miniflareWithInventoryAndOutbox({ registerFailsRemaining: 0, ...options });
  const namespace = (await mf.getDurableObjectNamespace(
    "HOLDOVER_WRITE_APP_INVENTORY",
  )) as unknown as HoldoverWriteAppInventoryNamespace;
  return {
    mf,
    inventory: new DurableHoldoverWriteAppInventoryClient(namespace),
    stub: namespace.get(namespace.idFromName(APP_ID)),
  };
}

function runAlarm(stub: ReturnType<HoldoverWriteAppInventoryNamespace["get"]>) {
  return stub.fetch("https://inventory.local/__test/alarm", { method: "POST" });
}

async function alarmStatus(stub: ReturnType<HoldoverWriteAppInventoryNamespace["get"]>) {
  return (await (await stub.fetch("https://inventory.local/__test/alarm-status")).json()) as {
    alarm: number | null;
    nowMs: number;
  };
}

async function release(runtime: Miniflare, path: string): Promise<void> {
  await runtime.dispatchFetch(`https://harness.local${path}`, { method: "POST" });
}
