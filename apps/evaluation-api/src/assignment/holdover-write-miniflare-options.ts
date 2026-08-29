export interface HoldoverWriteMiniflareOptions {
  registerFailsRemaining?: number;
  suppressPutFailsRemaining?: number;
  cancelStatePutFailsRemaining?: number;
  cancelKvDeleteFailsRemaining?: number;
  staleSuppressionReadsRemaining?: number;
  writerPutFailsRemaining?: number;
  purgeFailsRemaining?: number;
  markTransactionFailsBeforeCommitRemaining?: number;
  markTransactionThrowsAfterCommitRemaining?: number;
  pauseCancelAfterKvDelete?: boolean;
  pauseFinalizeAfterInventoryList?: boolean;
  missingSuppressionReadsRemaining?: number;
  pauseCancelAlarmAfterSnapshot?: boolean;
  pausePreparedAlarmAfterSnapshot?: boolean;
  pauseAssignmentWriterPut?: boolean;
}

const DEFAULT_OPTIONS = {
  registerFailsRemaining: 0,
  suppressPutFailsRemaining: 0,
  cancelStatePutFailsRemaining: 0,
  cancelKvDeleteFailsRemaining: 0,
  staleSuppressionReadsRemaining: 0,
  writerPutFailsRemaining: 0,
  purgeFailsRemaining: 0,
  markTransactionFailsBeforeCommitRemaining: 0,
  markTransactionThrowsAfterCommitRemaining: 0,
  pauseCancelAfterKvDelete: false,
  pauseFinalizeAfterInventoryList: false,
  missingSuppressionReadsRemaining: 0,
  pauseCancelAlarmAfterSnapshot: false,
  pausePreparedAlarmAfterSnapshot: false,
  pauseAssignmentWriterPut: false,
} satisfies Required<HoldoverWriteMiniflareOptions>;

export function resolveHoldoverWriteMiniflareOptions(
  options?: HoldoverWriteMiniflareOptions,
): Required<HoldoverWriteMiniflareOptions> {
  return { ...DEFAULT_OPTIONS, ...options };
}
