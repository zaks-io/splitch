import { isEntityEventSuppressed } from "./entity-metric-privacy";
import {
  appendRawEvent,
  tinybirdDelivery,
  toEvaluationUsageTinybirdRow,
  type EvaluationUsageEventInput,
} from "./tinybird";
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
  const usageDelivery = tinybirdDelivery(env, "raw_evaluations");
  const exposureDelivery = payload.exposureRows.length > 0 ? tinybirdDelivery(env) : null;
  if (!usageDelivery.ok) throw new Error(usageDelivery.error.message);
  if (exposureDelivery !== null && !exposureDelivery.ok) {
    throw new Error(exposureDelivery.error.message);
  }

  await appendRawEvent(
    toEvaluationUsageTinybirdRow({ eventId, ...payload.usage }),
    usageDelivery.value,
  );
  if (exposureDelivery?.ok) {
    for (const row of payload.exposureRows) {
      const suppressed = await isEntityEventSuppressed(
        env.ENTITY_METRIC_PRIVACY,
        row,
        env.SPLITCH_PLATFORM_TARGET,
      );
      if (!suppressed) await appendRawEvent(row, exposureDelivery.value);
    }
  }
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
