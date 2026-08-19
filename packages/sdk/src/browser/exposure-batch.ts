import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
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
  // First item is always included even when alone it exceeds the byte cap, so
  // the Worker can reject an oversize Exposure loudly (end is never 0 here).
  return end;
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

export function trimFailedOverflow(
  pending: QueuedExposure[],
  enqueuedFlags: Set<string>,
  logger: Logger,
): void {
  const lost = pending.splice(EXPOSURE_BATCH_MAX_ITEMS);
  for (const item of lost) {
    enqueuedFlags.delete(item.flagKey);
  }
  if (lost.length === 0) {
    return;
  }
  const retainedCount = pending.length;
  logger.error(
    formatSdkErrorMessage({
      code: "RATE_LIMITED",
      causeSummary: `Exposure queue overflow dropped ${lost.length} redemption(s) after a failed forced flush; retained ${retainedCount} for retry`,
      remediation:
        "Reduce concurrent first-reads or call flush() more often; excess exposureIds were discarded loudly",
    }),
    {
      droppedCount: lost.length,
      retainedCount,
      exposureIds: lost.map((item) => item.exposureId),
    },
  );
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
