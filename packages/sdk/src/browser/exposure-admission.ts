import type { Logger } from "../evaluate";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";
import { mintExposureId, pendingBodyBytes, type QueuedExposure } from "./exposure-batch";

export type ExposureAdmission =
  | { readonly admitted: false }
  | { readonly admitted: true; readonly atCapacity: boolean };

export function admitExposure(
  pending: QueuedExposure[],
  enqueuedFlags: Set<string>,
  logger: Logger,
  now: () => number,
  flagKey: string,
  exposureTicket: string,
): ExposureAdmission {
  if (enqueuedFlags.has(flagKey)) {
    return { admitted: false };
  }
  const exposureId = mintExposureId(logger, flagKey);
  enqueuedFlags.add(flagKey);
  pending.push({
    flagKey,
    exposureId,
    exposureTicket,
    clientTimestamp: new Date(now()).toISOString(),
  });
  return {
    admitted: true,
    atCapacity:
      pending.length >= EXPOSURE_BATCH_MAX_ITEMS ||
      pendingBodyBytes(pending) > EXPOSURE_BATCH_MAX_BODY_BYTES,
  };
}

export function rearmExposureFlags(enqueuedFlags: Set<string>, flagKeys: readonly string[]): void {
  for (const flagKey of flagKeys) {
    enqueuedFlags.delete(flagKey);
  }
}
