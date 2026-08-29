import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { miniflareWithInventoryAndOutbox } from "./holdover-write-app-inventory-miniflare-fixture";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "v1:hash-entity-1",
  identityVersion: "v1",
  runId: "run-42",
  variant: "treatment",
} as const;

describe("HoldoverWriteOutboxDurableObject exact retry cadence", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("keeps an exact pending ensure inert until its real alarm advances once", async () => {
    mf = miniflareWithInventoryAndOutbox({
      registerFailsRemaining: 0,
      writerPutFailsRemaining: 1,
    });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "owned" });
    const firstAlarm = await alarmTime(stub);
    expect(await writerAttempts(stub)).toBe(1);

    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "owned" });

    expect(await writerAttempts(stub)).toBe(1);
    expect(await alarmTime(stub)).toBe(firstAlarm);
    expect(await (await stub.fetch("https://outbox.local/status")).json()).toEqual({
      jobs: [expect.objectContaining({ status: "pending", attempt: 1 })],
    });

    await stub.fetch("https://outbox.local/__test/alarm", { method: "POST" });

    expect(await writerAttempts(stub)).toBe(2);
    expect(await (await stub.fetch("https://outbox.local/status")).json()).toEqual({
      status: "empty",
    });
  });
});

type OutboxStub = ReturnType<HoldoverWriteOutboxNamespace["get"]>;

async function alarmTime(stub: OutboxStub): Promise<number | null> {
  const response = await stub.fetch("https://outbox.local/__test/alarm-status");
  return ((await response.json()) as { alarm: number | null }).alarm;
}

async function writerAttempts(stub: OutboxStub): Promise<number> {
  const response = await stub.fetch("https://outbox.local/__test/writer-attempts");
  return ((await response.json()) as { attempts: number }).attempts;
}
