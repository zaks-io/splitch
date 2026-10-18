import { formatSdkErrorMessage, SplitchSdkError } from "../errors";
import { type Logger, sdkErrorForFailure } from "../evaluate";
import { retainRetryableExposures } from "../exposure-retry";
import type { ExposureBatchItem, ExposureBatchResult } from "../generated/contract-surface.js";
import { type QueuedExposure, takeBatch, toExposureBatchItems } from "./exposure-batch";
import type { ExposureOverflow } from "./exposure-overflow";
import type { ExposureRetryPolicy } from "./exposure-retry";
import type { BrowserExposuresResult, BrowserTransport } from "./transport";

async function redeemExposureBatch(
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

function applyExposureBatchResults(
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

function logMissingBatchResults(logger: Logger, unmatchedCount: number): void {
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

function logBatchFailure(
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

function logRejectedItem(
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

interface ExposureDrainDeps {
  readonly transport: Pick<BrowserTransport, "redeemExposures">;
  readonly logger: Logger;
  readonly pending: QueuedExposure[];
  readonly overflow: ExposureOverflow;
  readonly retryPolicy: ExposureRetryPolicy;
  readonly isClosed: () => boolean;
  readonly expiryError: () => SplitchSdkError | null;
  readonly onEnvironmentExpired: (error: SplitchSdkError) => void;
}

export async function redeemPendingExposureBatch(
  deps: ExposureDrainDeps,
  keepalive: boolean,
): Promise<{ completed: readonly ExposureBatchResult[]; retainedForRetry: boolean }> {
  const batch = takeBatch(deps.pending);
  const wireItems = toExposureBatchItems(batch);

  const result = await redeemExposureBatch(deps.transport, wireItems, keepalive);
  requireLiveEnvironment(deps, result, batch.length);
  if (result.results === null) {
    deps.overflow.retain(batch);
    throw logBatchFailure(
      deps.logger,
      result,
      batch.length,
      deps.retryPolicy.remediationForFailure(result, batch.length, deps.isClosed()),
    );
  }

  let outcome: ReturnType<typeof applyExposureBatchResults>;
  try {
    outcome = applyExposureBatchResults(batch, result.results, result.status, (item, row, status) =>
      logRejectedItem(deps.logger, item, row, status),
    );
  } catch (cause) {
    deps.overflow.retain(batch);
    deps.retryPolicy.recordFailure(result, batch.length);
    throw logZeroProgress(
      deps.logger,
      cause instanceof Error ? cause.message : "Exposure batch response is invalid",
      batch.length,
      cause,
    );
  }
  if (outcome.retained.length > 0) {
    deps.overflow.retain(outcome.retained);
  }
  if (outcome.unmatchedCount > 0) {
    deps.retryPolicy.recordFailure(result, outcome.retained.length);
    if (outcome.completed.length === 0) {
      throw logZeroProgress(
        deps.logger,
        "Exposure batch response made zero progress because it omitted one or more sent exposureIds",
        outcome.unmatchedCount,
      );
    }
    logMissingBatchResults(deps.logger, outcome.unmatchedCount);
    return { completed: outcome.completed, retainedForRetry: true };
  }
  if (outcome.retained.length > 0) {
    deps.retryPolicy.recordFailure(result, outcome.retained.length);
    return { completed: outcome.completed, retainedForRetry: true };
  }
  deps.retryPolicy.recordSuccess();
  return { completed: outcome.completed, retainedForRetry: false };
}

function requireLiveEnvironment(
  deps: ExposureDrainDeps,
  result: BrowserExposuresResult,
  count: number,
): void {
  const expired = deps.expiryError();
  if (expired !== null) throw expired;
  if (result.errorCode !== "ENVIRONMENT_EXPIRED") return;
  const error = sdkErrorForFailure("Exposure redemption", result);
  deps.onEnvironmentExpired(error);
  throw logBatchFailure(deps.logger, result, count, error.remediation);
}
