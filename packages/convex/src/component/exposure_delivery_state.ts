import type { CommitTsPlaceholder } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ensureRetentionScheduled } from "./retention";

export function commitTimestampIso(value: bigint | CommitTsPlaceholder): string {
  if (typeof value !== "bigint")
    throw new Error("Persisted Convex Exposure has an unresolved commit timestamp");
  return new Date(Number(value / 1_000_000n)).toISOString();
}

export async function makeExposureTerminal(
  ctx: MutationCtx,
  row: Doc<"exposureOutbox">,
  error: string | undefined,
): Promise<void> {
  await ctx.db.patch(row._id, {
    state: "terminal",
    targetingKeyHash: undefined,
    targetingKey: undefined,
    attributesJson: undefined,
    terminalAt: Date.now(),
    lastError: error,
  });
  await ensureRetentionScheduled(ctx);
}
