import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
import type { Logger } from "../evaluate";
import type { ExposureBatchResult } from "../generated/contract-surface.js";
import type { QueuedExposure } from "./exposure-batch";
import type { BrowserExposuresResult } from "./transport";

export function correlateBatchResults(
  batch: readonly QueuedExposure[],
  results: readonly ExposureBatchResult[],
  status: number | null,
  logRejected: (item: QueuedExposure, row: ExposureBatchResult, status: number | null) => void,
): { completed: ExposureBatchResult[]; retained: QueuedExposure[] } {
  const byId = new Map(results.map((row) => [row.exposureId, row]));
  const retained: QueuedExposure[] = [];
  const completed: ExposureBatchResult[] = [];
  for (const item of batch) {
    const row = byId.get(item.exposureId);
    if (row === undefined) {
      retained.push(item);
      continue;
    }
    completed.push(row);
    if (row.status === "rejected") {
      logRejected(item, row, status);
    }
  }
  return { completed, retained };
}

export function logZeroProgress(
  logger: Logger,
  causeSummary: string,
  pendingCount: number,
): SplitchSdkError {
  const error = new SplitchSdkError({
    code: "SERVICE_UNAVAILABLE",
    causeSummary,
    remediation:
      "Inspect the exposures response: every sent exposureId must appear in results, or flush fails loud",
  });
  logger.error(error.message, { errorCode: error.code, pendingCount });
  return error;
}

export const EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION =
  "Retry flush(); the pending batch is retained for the 5s retry";

export const EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION =
  "The pending batch was not sent and will not be retried; call flush() before close() or page teardown if redemption must complete";

export function logBatchFailure(
  logger: Logger,
  result: BrowserExposuresResult,
  count: number,
  remediation: string,
): SplitchSdkError {
  const error = new SplitchSdkError({
    code: result.errorCode ?? "SERVICE_UNAVAILABLE",
    causeSummary: result.errorMessage ?? "Exposure batch flush failed",
    remediation,
    status: result.status,
    originalError: result.cause,
  });
  logger.error(error.message, {
    status: result.status,
    errorCode: error.code,
    count,
    cause: result.cause,
  });
  return error;
}

export function logRejectedItem(
  logger: Logger,
  item: QueuedExposure,
  row: ExposureBatchResult,
  status: number | null,
): void {
  logger.error(
    formatSdkErrorMessage({
      code: row.code ?? "VALIDATION_ERROR",
      causeSummary: `Exposure redemption rejected for ${item.exposureId}`,
      remediation:
        "Refetch Precomputed Evaluations if the ticket expired; otherwise inspect the error code",
      status,
    }),
    { exposureId: item.exposureId, flagKey: item.flagKey, code: row.code },
  );
}
