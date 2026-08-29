import { deliverAppIdentityRow, identityVersionForRow } from "./entity-metric-privacy";
import { deliverEntityIdentityRow } from "./entity-identity-row-delivery";
import {
  appendRawEvent,
  tinybirdDelivery,
  toEvaluationUsageTinybirdRow,
  type EvaluationUsageEventInput,
} from "./tinybird";
import type { Env, TinybirdDelivery } from "./types";

export interface SealedEvaluationCommitPayload {
  readonly usage: EvaluationUsageEventInput;
  readonly exposureRows: readonly Record<string, unknown>[];
}

export async function deliverSealedEvaluationCommit(
  env: Env,
  eventId: string,
  payload: SealedEvaluationCommitPayload,
): Promise<void> {
  const usageDelivery = requireTinybirdDelivery(env, "raw_evaluations");
  const exposureDelivery =
    payload.exposureRows.length > 0 ? requireTinybirdDelivery(env) : undefined;

  const usageRow = toEvaluationUsageTinybirdRow({ eventId, ...payload.usage });
  await deliverUsage(env, payload, usageRow, usageDelivery);
  if (exposureDelivery === undefined) return;
  for (const row of payload.exposureRows) await deliverExposure(env, row, exposureDelivery);
}

function requireTinybirdDelivery(env: Env, datasource?: string): TinybirdDelivery {
  const delivery = tinybirdDelivery(env, datasource);
  if (!delivery.ok) throw new Error(delivery.error.message);
  return delivery.value;
}

async function deliverUsage(
  env: Env,
  payload: SealedEvaluationCommitPayload,
  row: Record<string, unknown>,
  delivery: TinybirdDelivery,
): Promise<void> {
  if (isDirectDelivery(env)) return appendRawEvent(row, delivery);
  await deliverAppIdentityRow(
    env.ENTITY_METRIC_PRIVACY,
    payload.usage.appId,
    payload.usage.identityVersion,
    "raw_evaluations",
    row,
    env.SPLITCH_PLATFORM_TARGET,
  );
}

async function deliverExposure(
  env: Env,
  row: Record<string, unknown>,
  delivery: TinybirdDelivery,
): Promise<void> {
  if (isDirectDelivery(env)) return appendRawEvent(row, delivery);
  await deliverEntityIdentityRow(
    env.ENTITY_METRIC_PRIVACY,
    identityVersionForRow(row),
    "raw_events",
    row,
    env.SPLITCH_PLATFORM_TARGET,
  );
}

function isDirectDelivery(env: Env): boolean {
  return env.SPLITCH_PLATFORM_TARGET === "local" || env.SPLITCH_PLATFORM_TARGET === "pr-ci";
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
