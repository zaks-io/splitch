import type { AppDeps } from "./app";
import type { AppEnvironmentDeps } from "./app-environment-model";
import type { DelegationBindings } from "./delegated-routes";
import {
  createEnvironmentExposureStatusCleanup,
  type EnvironmentExposureStatusCleanup,
} from "./environment-exposure-status-cleanup";
import {
  createHoldoverWriteOutboxCleanup,
  type HoldoverWriteOutboxCleanup,
} from "./holdover-write-outbox-cleanup";

function appEnvironmentCleanupDeps(deps: {
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

export function appEnvironmentHandlerDeps(deps: AppDeps): AppEnvironmentDeps {
  return {
    repo: deps.repo,
    credentialStore: deps.credentialStore,
    credentialCacheWriter: deps.credentialCacheWriter,
    configStore: deps.configStore,
    ...appEnvironmentCleanupDeps(deps),
    nowIso: deps.nowIso,
    onTeardownFault: (cause, requestId) =>
      deps.observability?.onError?.({
        requestId,
        code: "temporary_environment_teardown_failed",
        status: 503,
        cause,
      }),
  };
}
