import type {
  ConvexExposureVerificationConfig,
  ConvexServerExposureItem,
  ConvexServerExposureResponse,
} from "@splitch/contracts";
import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import type { AppIdentityAdmission } from "./app-identity-traffic";
import type { HoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import { errorCauseChain } from "./error-cause-chain";
import { recordIntegrationExposureStage } from "./integration-exposure-performance";

interface ConvexExposureHoldoverDeps {
  readonly holdoverWrite: HoldoverWriteCoordinator;
  readonly identityAdmission: AppIdentityAdmission;
  readonly integrationKind?: "convex" | "cloudflare";
  readonly logger?: Pick<Console, "error">;
  readonly spans?: PerformanceSpanRecorder;
}

export async function ensureConvexHoldover(
  item: ConvexServerExposureItem,
  targetingKeyHash: string,
  config: ConvexExposureVerificationConfig,
  deps: ConvexExposureHoldoverDeps,
): Promise<ConvexServerExposureResponse["results"][number] | null> {
  try {
    const result = await recordIntegrationExposureStage(
      deps.spans,
      deps.integrationKind ?? "convex",
      "holdover",
      () =>
        deps.holdoverWrite.ensure(
          {
            appId: config.appId,
            experimentId: item.experimentId,
            idType: item.evaluationContext.idType,
            targetingKeyHash,
            identityVersion: deps.identityAdmission.identityVersion,
            runId: item.runId,
            variant: item.variantName,
          },
          { sourceCreatedAtMs: Date.parse(item.exposureAt) },
        ),
    );
    if (result.status === "poisoned") {
      return rejected(item.exposureId, "INTERNAL_SERVER_ERROR", false);
    }
    if (result.status === "suppressed") {
      const code =
        deps.integrationKind === "cloudflare"
          ? "CLOUDFLARE_INSTALLATION_NOT_FOUND"
          : "CONVEX_INSTALLATION_NOT_FOUND";
      return rejected(item.exposureId, code, false);
    }
    return null;
  } catch (cause) {
    deps.logger?.error("convex_holdover_write_ensure_failed", {
      exposureId: item.exposureId,
      cause: errorCauseChain(cause),
    });
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE", true);
  }
}

function rejected(exposureId: string, code: string, retryable: boolean) {
  return { exposureId, status: "rejected" as const, code, message: code, retryable };
}
