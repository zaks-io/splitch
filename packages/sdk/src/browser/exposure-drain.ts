import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
import type { Logger } from "../evaluate";
import { retainRetryableExposures } from "../exposure-retry";
import type { ExposureBatchItem, ExposureBatchResult } from "../generated/contract-surface.js";
import type { QueuedExposure } from "./exposure-batch";
import type { BrowserExposuresResult, BrowserTransport } from "./transport";

export async function redeemExposureBatch(
  transport: Pick<BrowserTransport, "redeemExposures">,
  items: readonly ExposureBatchItem[],
  keepalive: boolean,
): Promise<BrowserExposuresResult> {
  try {
    return await transport.redeemExposures(items, { keepalive });
  } catch (cause) {
    return {
      status: null,
      results: null,
      errorCode: "SDK_TRANSPORT_NETWORK",
      errorMessage: cause instanceof Error ? cause.message : "Exposure transport rejected",
      cause,
    };
  }
}

export function applyExposureBatchResults(
  batch: readonly QueuedExposure[],
  results: readonly ExposureBatchResult[],
  status: number | null,
  logRejected: (item: QueuedExposure, row: ExposureBatchResult, status: number | null) => void,
): { completed: ExposureBatchResult[]; retained: QueuedExposure[]; unmatchedCount: number } {
  const retained = retainRetryableExposures(batch, results);
  const byId = new Map(results.map((row) => [row.exposureId, row]));
  const completed: ExposureBatchResult[] = [];
  let unmatchedCount = 0;
  for (const item of batch) {
    const row = byId.get(item.exposureId);
    if (row === undefined) {
      unmatchedCount += 1;
    } else {
      completed.push(row);
      if (row.status === "rejected") {
        logRejected(item, row, status);
      }
    }
  }
  return { completed, retained, unmatchedCount };
}

export function logZeroProgress(
  logger: Logger,
  causeSummary: string,
  pendingCount: number,
  originalError?: unknown,
): SplitchSdkError {
  const error = new SplitchSdkError({
    code: "SERVICE_UNAVAILABLE",
    causeSummary,
    remediation:
      "Inspect the exposures response: every sent exposureId must appear in results, or flush fails loud",
    originalError,
  });
  logger.error(error.message, { errorCode: error.code, pendingCount, cause: originalError });
  return error;
}

export function logMissingBatchResults(logger: Logger, unmatchedCount: number): void {
  const error = new SplitchSdkError({
    code: "SERVICE_UNAVAILABLE",
    causeSummary: `Exposure batch response omitted ${unmatchedCount} sent exposureId(s)`,
    remediation:
      "Inspect the exposures response: every sent exposureId must appear in results, or automatic delivery stops after the retry bound",
  });
  logger.error(error.message, { errorCode: error.code, unmatchedCount });
}

export const EXPOSURE_BATCH_FAILURE_RETRY_REMEDIATION =
  "Retry flush(); the pending batch is retained for the 5s retry (which will not fire if the page is discarded first)";

export const EXPOSURE_BATCH_FAILURE_NO_RETRY_REMEDIATION =
  "The pending batch was not sent and will not be retried; call flush() before close() or page teardown if redemption must complete";

export const EXPOSURE_BATCH_FAILURE_TERMINAL_REMEDIATION =
  "Automatic retries stopped; correct the delivery failure, then call flush() explicitly for the retained batch";

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
