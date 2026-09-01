import {
  type ExposureBatchRequest,
  ExposureBatchResponseSchema,
  type ExposureBatchResult,
  RETRYABLE_EXPOSURE_REJECTION_CODE,
} from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import {
  type AppIdentityAdmission,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "./app-identity-traffic";
import type { HoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import { errorCauseChain } from "./error-cause-chain";
import { assembleExposureFromTicket } from "./evaluate/exposure-assembly";
import type { ExposureTicketPayload, MintExposureTicketDeps } from "./evaluate/exposure-ticket";
import {
  type ExposureIngestSink,
  ExposureIngestSinkError,
  ticketFingerprint,
} from "./exposure-redemption";
import type { ExposureRedemptionClaimStore } from "./exposure-redemption-claim-core";
import {
  ensureHoldoverWrite,
  ingestFailureCode,
  logAndRejectClaimStoreFault,
  type RedemptionClaimContext,
  rejected,
  releaseClaimQuietly,
  verifyTicketForScope,
} from "./exposures-helpers";
import { type CredentialScope, credentialScope, exposureBatchBody } from "./exposures-request";

interface ExposuresRouteDeps {
  readonly holdoverWrite: HoldoverWriteCoordinator;
  readonly exposureIngestSink: ExposureIngestSink;
  readonly exposureRedemptionClaims: ExposureRedemptionClaimStore;
  readonly exposureTicket: MintExposureTicketDeps & { readonly previousTicketKey?: string };
  readonly sourceId: () => string;
  readonly logger?: { error(message: string, detail: unknown): void };
  readonly now?: () => Date;
}

export function makeExposuresHandler(deps: ExposuresRouteDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const scope = credentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });
    const admitted = await tryAdmitAppIdentity(deps.exposureTicket.saltStore, scope.value.appId);
    if (!admitted.ok) return renderError(admitted.error, { requestId });

    const body = exposureBatchBody(input);
    if (!body.ok) return renderError(body.error, { requestId });

    const results: ExposureBatchResult[] = [];
    for (const item of body.value.exposures) {
      results.push(await redeemOne(item, scope.value, admitted.admission, requestId, deps));
    }

    return Response.json(ExposureBatchResponseSchema.parse({ results }), { status: 202 });
  };
}

async function redeemOne(
  item: ExposureBatchRequest["exposures"][number],
  scope: CredentialScope,
  admission: AppIdentityAdmission,
  requestId: string,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  const verified = await verifyTicketForScope(item.exposureTicket, scope, admission, deps);
  if (!verified.ok) return rejected(item.exposureId, verified.code);
  const stale = await staleExposure(item.exposureId, admission);
  if (stale !== null) return stale;

  const fingerprint = await ticketFingerprint(item.exposureTicket);
  const claimInput = {
    requestId,
    appId: scope.appId,
    environmentId: scope.environmentId,
    exposureId: item.exposureId,
    ticketFingerprint: fingerprint,
  };

  let claim: Awaited<ReturnType<ExposureRedemptionClaimStore["claim"]>>;
  try {
    claim = await deps.exposureRedemptionClaims.claim(claimInput);
  } catch (cause) {
    return logAndRejectClaimStoreFault(
      "exposure_redemption_claim_failed",
      item.exposureId,
      claimInput,
      cause,
      deps,
    );
  }

  return completeClaim(claim, item, verified.payload, claimInput, scope, admission, deps);
}

async function completeClaim(
  claim: Awaited<ReturnType<ExposureRedemptionClaimStore["claim"]>>,
  item: ExposureBatchRequest["exposures"][number],
  ticket: ExposureTicketPayload,
  claimInput: RedemptionClaimContext,
  scope: CredentialScope,
  admission: AppIdentityAdmission,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  if (claim.status === "conflict") {
    return rejected(item.exposureId, "EVENT_ID_CONFLICT");
  }
  if (claim.status === "busy") {
    return rejected(item.exposureId, RETRYABLE_EXPOSURE_REJECTION_CODE);
  }
  if (claim.status === "deduplicated") {
    return completeDeduplicated(item.exposureId, ticket, scope, admission, deps);
  }
  if (claim.status === "resume_ack") {
    return completeAcknowledgeOnly(item.exposureId, claimInput, ticket, scope, admission, deps);
  }
  return sealIngestAndConfirm(item, ticket, claimInput, scope, admission, deps);
}

async function completeDeduplicated(
  exposureId: string,
  ticket: ExposureTicketPayload,
  scope: CredentialScope,
  admission: AppIdentityAdmission,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  const stale = await staleExposure(exposureId, admission);
  if (stale !== null) return stale;
  const holdoverFault = await ensureHoldoverWrite(ticket, scope, exposureId, deps);
  if (holdoverFault) return holdoverFault;
  const staleBeforeSuccess = await staleExposure(exposureId, admission);
  return staleBeforeSuccess ?? { exposureId, status: "deduplicated", code: null };
}

async function completeAcknowledgeOnly(
  exposureId: string,
  claimInput: RedemptionClaimContext,
  ticket: ExposureTicketPayload,
  scope: CredentialScope,
  admission: AppIdentityAdmission,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  const stale = await staleExposure(exposureId, admission);
  if (stale !== null) return stale;
  try {
    const ack = await deps.exposureRedemptionClaims.acknowledge(claimInput);
    const holdoverFault = await ensureHoldoverWrite(ticket, scope, exposureId, deps);
    if (holdoverFault) return holdoverFault;
    const staleBeforeSuccess = await staleExposure(exposureId, admission);
    if (staleBeforeSuccess !== null) return staleBeforeSuccess;
    return {
      exposureId,
      status: ack.status === "already_accepted" ? "deduplicated" : "accepted",
      code: null,
    };
  } catch (cause) {
    const holdoverFault = await ensureHoldoverWrite(ticket, scope, exposureId, deps);
    if (holdoverFault) return holdoverFault;
    return logAndRejectClaimStoreFault(
      "exposure_redemption_acknowledge_failed",
      exposureId,
      claimInput,
      cause,
      deps,
    );
  }
}

async function sealIngestAndConfirm(
  item: ExposureBatchRequest["exposures"][number],
  ticket: ExposureTicketPayload,
  claimInput: RedemptionClaimContext,
  scope: CredentialScope,
  admission: AppIdentityAdmission,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  const stale = await staleExposure(item.exposureId, admission);
  if (stale !== null) return stale;
  const exposure = await assembleExposureFromTicket({
    ticket,
    appId: claimInput.appId,
    environmentId: claimInput.environmentId,
    exposureId: item.exposureId,
    clientTimestamp: item.clientTimestamp,
    sourceId: deps.sourceId(),
    now: deps.now ?? deps.exposureTicket.now,
  });

  const ingestFailure = await ingestExposure(
    exposure,
    item.exposureId,
    claimInput,
    admission,
    deps,
  );
  if (ingestFailure !== null) return ingestFailure;

  try {
    const staleBeforeConfirm = await staleExposure(item.exposureId, admission);
    if (staleBeforeConfirm !== null) return staleBeforeConfirm;
    await deps.exposureRedemptionClaims.markSealed(claimInput);
    const ack = await deps.exposureRedemptionClaims.acknowledge(claimInput);
    const holdoverFault = await ensureHoldoverWrite(ticket, scope, item.exposureId, deps);
    if (holdoverFault) return holdoverFault;
    const staleBeforeSuccess = await staleExposure(item.exposureId, admission);
    if (staleBeforeSuccess !== null) return staleBeforeSuccess;
    return {
      exposureId: item.exposureId,
      status: ack.status === "already_accepted" ? "deduplicated" : "accepted",
      code: null,
    };
  } catch (cause) {
    // Ingest already committed. Holdover must be completed or durably owned
    // before any ack that lets the browser drop the queue item (SPL-346).
    // Classification is via the claim-store seam:
    // - Transient (SERVICE_UNAVAILABLE): SDK retries. If markSealed succeeded,
    //   exact-ID retry uses resume_ack (no second append). If markSealed failed,
    //   the claim stays pending until EXPOSURE_REDEMPTION_PENDING_LEASE_MS —
    //   then a retry may re-acquire and append again (accepted ambiguous-window
    //   risk; see that constant).
    // - Deterministic (INTERNAL_SERVER_ERROR): SDK drops; no retry, so the
    //   pending-lease re-acquire path does not run for 409 / protocol faults.
    const holdoverFault = await ensureHoldoverWrite(ticket, scope, item.exposureId, deps);
    if (holdoverFault) return holdoverFault;
    return logAndRejectClaimStoreFault(
      "exposure_redemption_confirm_failed",
      item.exposureId,
      claimInput,
      cause,
      deps,
    );
  }
}

async function ingestExposure(
  exposure: Parameters<ExposuresRouteDeps["exposureIngestSink"]["write"]>[0],
  exposureId: string,
  claimInput: RedemptionClaimContext,
  admission: AppIdentityAdmission,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult | null> {
  const stale = await staleExposure(exposureId, admission);
  if (stale !== null) return stale;
  try {
    await deps.exposureIngestSink.write(exposure);
    return null;
  } catch (cause) {
    await releaseClaimQuietly(claimInput, deps);
    deps.logger?.error("exposure_ingest_sink_failed", {
      requestId: claimInput.requestId,
      ...(cause instanceof ExposureIngestSinkError ? { status: cause.status } : {}),
      appId: claimInput.appId,
      environmentId: claimInput.environmentId,
      exposureId,
      causeChain: errorCauseChain(cause),
    });
    return rejected(
      exposureId,
      cause instanceof ExposureIngestSinkError
        ? ingestFailureCode(cause.status)
        : RETRYABLE_EXPOSURE_REJECTION_CODE,
    );
  }
}

async function staleExposure(
  exposureId: string,
  admission: AppIdentityAdmission,
): Promise<ExposureBatchResult | null> {
  return (await appIdentityAdmissionValidationError(admission)) === null
    ? null
    : rejected(exposureId, RETRYABLE_EXPOSURE_REJECTION_CODE);
}
