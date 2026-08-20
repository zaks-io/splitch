import { Miniflare } from "miniflare";
import { bundleHoldoverWriteInventoryAndOutboxWorker } from "./holdover-write-miniflare-bundle";

export interface HoldoverWriteMiniflareOptions {
  registerFailsRemaining: number;
  suppressPutFailsRemaining?: number;
  cancelStatePutFailsRemaining?: number;
  cancelKvDeleteFailsRemaining?: number;
  staleSuppressionReadsRemaining?: number;
  writerPutFailsRemaining?: number;
  purgeFailsRemaining?: number;
  markTransactionFailsBeforeCommitRemaining?: number;
  markTransactionThrowsAfterCommitRemaining?: number;
  pauseCancelAfterKvDelete?: boolean;
  pauseFinalizeAfterInventoryList?: boolean;
  missingSuppressionReadsRemaining?: number;
}

export interface DeadlockBarrierStatus {
  readonly cancelKvDeleteReached: boolean;
  readonly ensureRegisterAttempts: number;
  readonly finalizeInventoryListReached: boolean;
}

export function miniflareWithInventoryAndOutbox(options: HoldoverWriteMiniflareOptions): Miniflare {
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

export async function waitForDeadlockBarrier(
  runtime: Miniflare,
  ready: (status: DeadlockBarrierStatus) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = (await (
      await runtime.dispatchFetch("https://harness.local/__test/deadlock-barrier-status")
    ).json()) as DeadlockBarrierStatus;
    if (ready(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("two-DO deadlock barrier was not reached");
}

export async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("two-DO operations did not settle")), timeoutMs),
    ),
  ]);
}
