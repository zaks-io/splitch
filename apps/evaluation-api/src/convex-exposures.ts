import type {
  ConvexExposureVerificationConfig,
  ConvexExposureVerificationResult,
  ConvexServerExposureItem,
  ConvexServerExposureResponse,
  ExposureEvent,
} from "@splitch/contracts";
import {
  ConvexServerExposureRequestSchema,
  ConvexServerExposureResponseSchema,
} from "@splitch/contracts";
import { type EvaluatePathDeps, evaluatePath } from "@splitch/evaluation-core";
import type { PerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import type { SaltStore } from "@splitch/privacy";
import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import {
  type AppIdentityAdmission,
  admittedEvaluatePathDeps,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "./app-identity-traffic";
import type { HoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import { settleVerifiedIntegrationExposureBatch } from "./convex-exposure-batch";
import { confirmConvexExposureClaim } from "./convex-exposure-confirmation";
import { ensureConvexHoldover } from "./convex-exposure-holdover";
import {
  EMPTY_CONVEX_ASSIGNMENTS,
  frozenConvexRunProvider,
  isConvexExposureTimeAccepted,
  makeConvexExposureEvent,
  matchesConvexExposure,
  sha256Hex,
} from "./convex-exposure-evaluation";
import type { ExposureIngestSink } from "./exposure-redemption";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import { recordIntegrationExposureStage } from "./integration-exposure-performance";

export interface ConvexExposureConfigurationResolver {
  resolveBatch(
    principal: Principal,
    items: readonly ConvexServerExposureItem[],
    requestId: string,
  ): Promise<readonly ConvexExposureVerificationResult[]>;
}

interface ConvexExposureDeps extends EvaluatePathDeps {
  convexConfigurationResolver?: ConvexExposureConfigurationResolver;
  configurationResolver?: ConvexExposureConfigurationResolver;
  integrationKind?: "convex" | "cloudflare";
  exposureIngestSink: ExposureIngestSink;
  exposureRedemptionClaims: ExposureRedemptionClaimStore;
  holdoverWrite: HoldoverWriteCoordinator;
  saltStore: SaltStore;
  spans?: PerformanceSpanRecorder;
  now?: () => Date;
}

type AdmittedConvexExposureDeps = ConvexExposureDeps & {
  readonly identityAdmission: AppIdentityAdmission;
};

export function makeConvexExposuresHandler(deps: ConvexExposureDeps) {
  return (args: HandlerArgs<unknown>): Promise<Response> => handleBatch(args, deps);
}

async function handleBatch(
  { input, principal, requestId }: HandlerArgs<unknown>,
  deps: ConvexExposureDeps,
): Promise<Response> {
  if (!principal.appId || !principal.environmentId) {
    return Response.json(
      { code: "SERVICE_UNAVAILABLE", message: "credential scope is unavailable", details: {} },
      { status: 503 },
    );
  }
  const appId = principal.appId;
  const sourceKind = deps.integrationKind ?? "convex";
  const resolver =
    deps.configurationResolver ??
    (sourceKind === "convex" ? deps.convexConfigurationResolver : undefined);
  if (!resolver) {
    return Response.json(
      {
        code: "SERVICE_UNAVAILABLE",
        message: `${sourceKind} installation verification is unavailable`,
        details: {},
      },
      { status: 503 },
    );
  }
  const body = ConvexServerExposureRequestSchema.parse(inputBody(input));
  // Configuration is a read, so it can start beside identity admission. Its
  // rejection is observed immediately while admission retains fail-fast precedence.
  const resolved = recordIntegrationExposureStage(deps.spans, sourceKind, "configuration", () =>
    resolver.resolveBatch(principal, body.exposures, requestId),
  );
  void resolved.catch(() => undefined);
  const admitted = await recordIntegrationExposureStage(
    deps.spans,
    sourceKind,
    "identity admission",
    () => tryAdmitAppIdentity(deps.saltStore, appId),
  );
  if (!admitted.ok) return Response.json(admitted.error, { status: 503 });
  const requestDeps: AdmittedConvexExposureDeps = {
    ...admittedEvaluatePathDeps(deps, admitted.admission),
    saltStore: admitted.admission.saltStore,
    identityAdmission: admitted.admission,
  };
  const results = await settleVerifiedIntegrationExposureBatch(
    sourceKind,
    body.exposures,
    await resolved,
    (verification, item) => verifyAndIngest(verification, sourceKind, item, requestDeps),
  );
  return Response.json(ConvexServerExposureResponseSchema.parse({ results }), { status: 202 });
}

async function verifyAndIngest(
  verification: ConvexExposureVerificationResult,
  sourceKind: "convex" | "cloudflare",
  item: ConvexServerExposureItem,
  deps: AdmittedConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  if (verification.status === "installation_not_found")
    return rejected(item.exposureId, installationNotFoundCode(sourceKind), false);
  if (verification.status === "configuration_not_found")
    return rejected(item.exposureId, "STALE_CONFIGURATION", false);
  if (verification.config.appId !== deps.identityAdmission.appId) {
    return rejected(item.exposureId, "STALE_CONFIGURATION", false);
  }
  return ingestOne(item, verification.config, deps);
}

async function ingestOne(
  item: ConvexServerExposureItem,
  config: ConvexExposureVerificationConfig,
  deps: AdmittedConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  const now = (deps.now ?? (() => new Date()))();
  const stale = await staleIntegration(item.exposureId, deps.identityAdmission);
  if (stale !== null) return stale;
  if (!isConvexExposureTimeAccepted(item.exposureAt, config, now)) {
    return rejected(item.exposureId, "VALIDATION_ERROR", false);
  }
  const decision = await evaluatePath(
    {
      appId: config.appId,
      environmentId: config.environmentId,
      flagKey: item.flagKey,
      evaluationContext: item.evaluationContext,
    },
    {
      ...deps,
      provider: frozenConvexRunProvider(config),
      assignmentStore: EMPTY_CONVEX_ASSIGNMENTS,
    },
  );
  if (!matchesConvexExposure(item, decision.exposure, config)) {
    return rejected(item.exposureId, "STALE_CONFIGURATION", false);
  }

  const exposure = await makeConvexExposureEvent(item, config.appId, config.environmentId, {
    ...deps,
    sourceKind: deps.integrationKind,
  });
  const fingerprint = await sha256Hex(JSON.stringify(item));
  const claimInput = {
    appId: config.appId,
    environmentId: config.environmentId,
    exposureId: item.exposureId,
    ticketFingerprint: fingerprint,
  };
  const staleBeforeClaim = await staleIntegration(item.exposureId, deps.identityAdmission);
  if (staleBeforeClaim !== null) return staleBeforeClaim;
  const claim = await recordIntegrationExposureStage(
    deps.spans,
    deps.integrationKind ?? "convex",
    "claim",
    () => deps.exposureRedemptionClaims.claim(claimInput),
  );
  if (claim.status !== "acquired") {
    return completeExistingClaim(claim, claimInput, item, exposure.targetingKeyHash, config, deps);
  }

  return ingestAcquiredClaim(claimInput, item, exposure, config, deps);
}

async function completeExistingClaim(
  claim: Exclude<ExposureRedemptionClaimOutcome, { status: "acquired" }>,
  claimInput: ExposureRedemptionClaimInput,
  item: ConvexServerExposureItem,
  targetingKeyHash: string,
  config: ConvexExposureVerificationConfig,
  deps: AdmittedConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  if (claim.status === "conflict") return rejected(item.exposureId, "EVENT_ID_CONFLICT", false);
  if (claim.status === "busy") return rejected(item.exposureId, "SERVICE_UNAVAILABLE", true);

  const acknowledged =
    claim.status === "resume_ack"
      ? await recordIntegrationExposureStage(
          deps.spans,
          deps.integrationKind ?? "convex",
          "confirmation",
          () => deps.exposureRedemptionClaims.acknowledge(claimInput),
        )
      : null;
  const stale = await staleIntegration(item.exposureId, deps.identityAdmission);
  if (stale !== null) return stale;
  const holdoverFault = await ensureConvexHoldover(item, targetingKeyHash, config, deps);
  if (holdoverFault) return holdoverFault;
  const staleBeforeSuccess = await staleIntegration(item.exposureId, deps.identityAdmission);
  if (staleBeforeSuccess !== null) return staleBeforeSuccess;
  return {
    exposureId: item.exposureId,
    status: acknowledged?.status === "accepted" ? "accepted" : "deduplicated",
  };
}

async function ingestAcquiredClaim(
  claimInput: ExposureRedemptionClaimInput,
  item: ConvexServerExposureItem,
  exposure: ExposureEvent & { isHoldover: false },
  config: ConvexExposureVerificationConfig,
  deps: AdmittedConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  const stale = await staleIntegration(item.exposureId, deps.identityAdmission);
  if (stale !== null) return stale;
  try {
    await recordIntegrationExposureStage(
      deps.spans,
      deps.integrationKind ?? "convex",
      "ingest",
      () => deps.exposureIngestSink.write(exposure),
    );
  } catch (cause) {
    await deps.exposureRedemptionClaims.release(claimInput);
    deps.logger?.error("convex_exposure_ingest_failed", { exposureId: item.exposureId, cause });
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE", true);
  }

  const staleBeforeConfirm = await staleIntegration(item.exposureId, deps.identityAdmission);
  if (staleBeforeConfirm !== null) return staleBeforeConfirm;
  // Once Event Ingest commits, claim confirmation and holdover persistence are
  // independent durable obligations. Both still finish before success returns.
  const [confirmationFault, holdoverFault] = await Promise.all([
    recordIntegrationExposureStage(
      deps.spans,
      deps.integrationKind ?? "convex",
      "confirmation",
      () => confirmConvexExposureClaim(claimInput, item, deps),
    ),
    ensureConvexHoldover(item, exposure.targetingKeyHash, config, deps),
  ]);
  if (holdoverFault) return holdoverFault;
  if (confirmationFault) return confirmationFault;
  const staleBeforeSuccess = await staleIntegration(item.exposureId, deps.identityAdmission);
  if (staleBeforeSuccess !== null) return staleBeforeSuccess;
  return { exposureId: item.exposureId, status: "accepted" };
}

function inputBody(input: unknown): unknown {
  return typeof input === "object" && input !== null && "body" in input
    ? (input as { body: unknown }).body
    : undefined;
}

function rejected(exposureId: string, code: string, retryable: boolean) {
  return { exposureId, status: "rejected" as const, code, message: code, retryable };
}

async function staleIntegration(
  exposureId: string,
  admission: AppIdentityAdmission,
): Promise<ConvexServerExposureResponse["results"][number] | null> {
  return (await appIdentityAdmissionValidationError(admission)) === null
    ? null
    : rejected(exposureId, "SERVICE_UNAVAILABLE", true);
}

function installationNotFoundCode(kind: "convex" | "cloudflare"): string {
  return kind === "cloudflare"
    ? "CLOUDFLARE_INSTALLATION_NOT_FOUND"
    : "CONVEX_INSTALLATION_NOT_FOUND";
}
