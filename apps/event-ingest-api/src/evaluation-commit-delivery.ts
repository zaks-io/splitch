import { enqueueRawEvent, enqueueRawEvents } from "./raw-event-queue-envelope";
import { type EvaluationUsageEventInput, toEvaluationUsageTinybirdRow } from "./tinybird";
import type { Env } from "./types";

export interface SealedEvaluationCommitPayload {
  readonly usage: EvaluationUsageEventInput;
  readonly exposureRows: readonly Record<string, unknown>[];
}

export async function deliverSealedEvaluationCommit(
  env: Env,
  eventId: string,
  payload: SealedEvaluationCommitPayload,
): Promise<void> {
  const usageRow = toEvaluationUsageTinybirdRow({ eventId, ...payload.usage });
  await enqueueRawEvent(env, "raw_evaluations", usageRow);
  await enqueueRawEvents(env, "raw_events", payload.exposureRows);
}

export function parseSealedEvaluationCommitPayload(value: unknown): SealedEvaluationCommitPayload {
  if (!isRecord(value) || !isRecord(value.usage) || !Array.isArray(value.exposureRows)) {
    throw new Error("Evaluation commit payload is invalid");
  }
  if (value.exposureRows.some((row) => !isRecord(row))) {
    throw new Error("Evaluation commit Exposure row is invalid");
  }
  return value as unknown as SealedEvaluationCommitPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
