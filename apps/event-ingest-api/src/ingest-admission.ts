import type { ErrorResponse } from "@splitch/contracts";
import { renderError } from "./errors";
import type { IngestStream } from "./ingest-admission-config";
import {
  type AdmissionCost,
  chargeIngestAdmission,
  type IngestAdmissionGateNamespace,
  queuePayloadBytes,
} from "./ingest-admission-gate";

export function ingestAdmissionCost(rows: readonly Record<string, unknown>[]): AdmissionCost {
  let byteCost = 0;
  for (const row of rows) {
    byteCost += queuePayloadBytes(row);
  }
  return { rowCost: rows.length, byteCost };
}

/**
 * Charge queued serialized bytes and logical row counts before a stream accepts.
 * A missing or invalid gate is a rejection, never an allow.
 */
export async function ingestAdmissionDenial(
  namespace: IngestAdmissionGateNamespace | undefined,
  scope: {
    readonly appId: string;
    readonly environmentId: string;
    readonly ingestStream: IngestStream;
  },
  rows: readonly Record<string, unknown>[],
  exceededMessage: string,
): Promise<ErrorResponse | null> {
  if (rows.length === 0) return null;
  try {
    const admission = await chargeIngestAdmission(namespace, scope, ingestAdmissionCost(rows));
    if (admission.allowed) return null;
    return {
      code: "RATE_LIMITED",
      message: exceededMessage,
      details: { retryAfterMs: admission.retryAfterMs },
    };
  } catch {
    return {
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
      details: { retryAfterMs: 1_000 },
    };
  }
}

export async function rejectIngestAdmission(
  namespace: IngestAdmissionGateNamespace | undefined,
  scope: {
    readonly appId: string;
    readonly environmentId: string;
    readonly ingestStream: IngestStream;
  },
  rows: readonly Record<string, unknown>[],
  exceededMessage: string,
): Promise<Response | null> {
  const denied = await ingestAdmissionDenial(namespace, scope, rows, exceededMessage);
  return denied === null ? null : renderError(denied);
}
