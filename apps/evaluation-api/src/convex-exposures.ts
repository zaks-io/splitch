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
import type { SaltStore } from "@splitch/privacy";
import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import type { HoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import {
  EMPTY_CONVEX_ASSIGNMENTS,
  frozenConvexRunProvider,
  isConvexExposureTimeAccepted,
  makeConvexExposureEvent,
  matchesConvexExposure,
  sha256Hex,
} from "./convex-exposure-evaluation";
import { errorCauseChain } from "./error-cause-chain";
import type { ExposureIngestSink } from "./exposure-redemption";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";

export interface ConvexExposureConfigurationResolver {
  resolve(
    principal: Principal,
    item: ConvexServerExposureItem,
    requestId: string,
  ): Promise<ConvexExposureVerificationResult>;
}

interface ConvexExposureDeps extends EvaluatePathDeps {
  convexConfigurationResolver?: ConvexExposureConfigurationResolver;
  configurationResolver?: ConvexExposureConfigurationResolver;
  integrationKind?: "convex" | "cloudflare";
  exposureIngestSink: ExposureIngestSink;
  exposureRedemptionClaims: ExposureRedemptionClaimStore;
  holdoverWrite: HoldoverWriteCoordinator;
  saltStore: SaltStore;
  now?: () => Date;
}

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
  const results: ConvexServerExposureResponse["results"] = [];
  for (const item of body.exposures) {
    results.push(await verifyAndIngest(resolver, sourceKind, principal, item, requestId, deps));
  }
  return Response.json(ConvexServerExposureResponseSchema.parse({ results }), { status: 202 });
}

async function verifyAndIngest(
  resolver: ConvexExposureConfigurationResolver,
  sourceKind: "convex" | "cloudflare",
  principal: Principal,
  item: ConvexServerExposureItem,
  requestId: string,
  deps: ConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  const verification = await resolver.resolve(principal, item, requestId);
  if (verification.status === "installation_not_found")
    return rejected(item.exposureId, installationNotFoundCode(sourceKind), false);
  if (verification.status === "configuration_not_found")
    return rejected(item.exposureId, "STALE_CONFIGURATION", false);
  return ingestOne(item, verification.config, deps);
}

async function ingestOne(
  item: ConvexServerExposureItem,
  config: ConvexExposureVerificationConfig,
  deps: ConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  const now = (deps.now ?? (() => new Date()))();
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
  const claim = await deps.exposureRedemptionClaims.claim(claimInput);
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
  deps: ConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  if (claim.status === "conflict") return rejected(item.exposureId, "EVENT_ID_CONFLICT", false);
  if (claim.status === "busy") return rejected(item.exposureId, "SERVICE_UNAVAILABLE", true);

  const acknowledged =
    claim.status === "resume_ack"
      ? await deps.exposureRedemptionClaims.acknowledge(claimInput)
      : null;
  const holdoverFault = await ensureConvexHoldover(item, targetingKeyHash, config, deps);
  if (holdoverFault) return holdoverFault;
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
  deps: ConvexExposureDeps,
): Promise<ConvexServerExposureResponse["results"][number]> {
  try {
    await deps.exposureIngestSink.write(exposure);
  } catch (cause) {
    await deps.exposureRedemptionClaims.release(claimInput);
    deps.logger?.error("convex_exposure_ingest_failed", { exposureId: item.exposureId, cause });
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE", true);
  }

  try {
    await deps.exposureRedemptionClaims.markSealed(claimInput);
    await deps.exposureRedemptionClaims.acknowledge(claimInput);
  } catch (cause) {
    // Event Ingest already committed. Keep the claim so an exact retry resumes
    // acknowledgment instead of appending the Exposure a second time.
    deps.logger?.error("convex_exposure_confirm_failed", {
      exposureId: item.exposureId,
      cause: errorCauseChain(cause),
    });
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE", true);
  }

  const holdoverFault = await ensureConvexHoldover(item, exposure.targetingKeyHash, config, deps);
  if (holdoverFault) return holdoverFault;
  return { exposureId: item.exposureId, status: "accepted" };
}

async function ensureConvexHoldover(
  item: ConvexServerExposureItem,
  targetingKeyHash: string,
  config: ConvexExposureVerificationConfig,
  deps: Pick<ConvexExposureDeps, "holdoverWrite" | "logger" | "integrationKind">,
): Promise<ConvexServerExposureResponse["results"][number] | null> {
  try {
    const result = await deps.holdoverWrite.ensure(
      {
        appId: config.appId,
        experimentId: item.experimentId,
        idType: item.evaluationContext.idType,
        targetingKeyHash,
        runId: item.runId,
        variant: item.variantName,
      },
      { sourceCreatedAtMs: Date.parse(item.exposureAt) },
    );
    if (result.status === "poisoned") {
      return rejected(item.exposureId, "INTERNAL_SERVER_ERROR", false);
    }
    if (result.status === "suppressed") {
      return rejected(
        item.exposureId,
        installationNotFoundCode(deps.integrationKind ?? "convex"),
        false,
      );
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

function inputBody(input: unknown): unknown {
  return typeof input === "object" && input !== null && "body" in input
    ? (input as { body: unknown }).body
    : undefined;
}

function rejected(exposureId: string, code: string, retryable: boolean) {
  return { exposureId, status: "rejected" as const, code, message: code, retryable };
}

function installationNotFoundCode(kind: "convex" | "cloudflare"): string {
  return kind === "cloudflare"
    ? "CLOUDFLARE_INSTALLATION_NOT_FOUND"
    : "CONVEX_INSTALLATION_NOT_FOUND";
}
