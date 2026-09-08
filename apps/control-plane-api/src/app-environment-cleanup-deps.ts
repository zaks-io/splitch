import type { DelegationBindings } from "./delegated-routes";
import {
  createEnvironmentExposureStatusCleanup,
  type EnvironmentExposureStatusCleanup,
} from "./environment-exposure-status-cleanup";
import {
  createHoldoverWriteOutboxCleanup,
  type HoldoverWriteOutboxCleanup,
} from "./holdover-write-outbox-cleanup";

export function appEnvironmentCleanupDeps(deps: {
  readonly exposureStatusCleanup?: EnvironmentExposureStatusCleanup;
  readonly holdoverWriteOutboxCleanup?: HoldoverWriteOutboxCleanup;
  readonly delegationBindings?: DelegationBindings;
  readonly privacyExports?: R2Bucket;
}): {
  exposureStatusCleanup: EnvironmentExposureStatusCleanup;
  holdoverWriteOutboxCleanup: HoldoverWriteOutboxCleanup;
  privacyExports: R2Bucket | undefined;
} {
  return {
    exposureStatusCleanup:
      deps.exposureStatusCleanup ??
      createEnvironmentExposureStatusCleanup(deps.delegationBindings?.["analysis-api"]),
    holdoverWriteOutboxCleanup:
      deps.holdoverWriteOutboxCleanup ??
      createHoldoverWriteOutboxCleanup(deps.delegationBindings?.["evaluation-api"]),
    privacyExports: deps.privacyExports,
  };
}
