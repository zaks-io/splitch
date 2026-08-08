import { SplitchSdkError } from "../errors";
import type { Logger } from "../evaluate";
import type { ExposureBatchItem } from "../generated/contract-surface.js";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";

export interface QueuedExposure extends ExposureBatchItem {
  readonly flagKey: string;
}

export function takeBatch(pending: QueuedExposure[]): QueuedExposure[] {
  if (pending.length === 0) {
    return [];
  }
  const end = batchEndIndex(pending);
  return pending.splice(0, end);
}

/** How many leading pending items fit under both batch caps. */
function batchEndIndex(pending: readonly QueuedExposure[]): number {
  let end = 0;
  let bytes = bodyPrefixBytes();
  for (const next of pending) {
    if (end >= EXPOSURE_BATCH_MAX_ITEMS) {
      break;
    }
    const itemBytes = itemWireBytes(next) + (end === 0 ? 0 : 1);
    if (end > 0 && bytes + itemBytes + 2 > EXPOSURE_BATCH_MAX_BODY_BYTES) {
      break;
    }
    bytes += itemBytes;
    end += 1;
  }
  // Single oversize item: still send it alone so the Worker rejects loudly.
  return end === 0 ? 1 : end;
}

export function pendingBodyBytes(items: readonly QueuedExposure[]): number {
  const wire = {
    exposures: items.map(({ exposureId, exposureTicket, clientTimestamp }) => ({
      exposureId,
      exposureTicket,
      clientTimestamp,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(wire)).byteLength;
}

export function mintExposureId(logger: Logger, flagKey: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    const error = new SplitchSdkError({
      code: "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
      causeSummary:
        "crypto.randomUUID is unavailable, so the browser client could not mint an exposureId",
      remediation:
        "Serve the page from a secure context (https:// or localhost) where crypto.randomUUID exists",
    });
    logger.error(error.message, { flagKey, errorCode: error.code });
    throw error;
  }
  return globalThis.crypto.randomUUID();
}

function bodyPrefixBytes(): number {
  // {"exposures":[]}
  return 16;
}

function itemWireBytes(item: QueuedExposure): number {
  return new TextEncoder().encode(
    JSON.stringify({
      exposureId: item.exposureId,
      exposureTicket: item.exposureTicket,
      clientTimestamp: item.clientTimestamp,
    }),
  ).byteLength;
}
