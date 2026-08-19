import {
  type ExposureBatchRequest,
  ExposureBatchResponseSchema,
  type ExposureBatchResult,
  RETRYABLE_EXPOSURE_REJECTION_CODE,
} from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
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
  readonly sourceId: string;
  readonly logger?: { error(message: string, detail: unknown): void };
  readonly now?: () => Date;
}

export function makeExposuresHandler(deps: ExposuresRouteDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const scope = credentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });

    const body = exposureBatchBody(input);
    if (!body.ok) return renderError(body.error, { requestId });

    const results: ExposureBatchResult[] = [];
    for (const item of body.value.exposures) {
      results.push(await redeemOne(item, scope.value, requestId, deps));
    }

    return Response.json(ExposureBatchResponseSchema.parse({ results }), { status: 202 });
  };
}

async function redeemOne(
  item: ExposureBatchRequest["exposures"][number],
  scope: CredentialScope,
  requestId: string,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  const verified = await verifyTicketForScope(item.exposureTicket, scope, deps);
  if (!verified.ok) return rejected(item.exposureId, verified.code);

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

  if (claim.status === "conflict") {
    return rejected(item.exposureId, "EVENT_ID_CONFLICT");
  }
  if (claim.status === "busy") {
    return rejected(item.exposureId, RETRYABLE_EXPOSURE_REJECTION_CODE);
  }
  if (claim.status === "deduplicated") {
    const holdoverFault = await ensureHoldoverWrite(verified.payload, scope, item.exposureId, deps);
    if (holdoverFault) return holdoverFault;
    return { exposureId: item.exposureId, status: "deduplicated", code: null };
  }
  if (claim.status === "resume_ack") {
    return completeAcknowledgeOnly(item.exposureId, claimInput, verified.payload, scope, deps);
  }
  return sealIngestAndConfirm(item, verified.payload, claimInput, scope, deps);
}

async function completeAcknowledgeOnly(
  exposureId: string,
  claimInput: RedemptionClaimContext,
  ticket: ExposureTicketPayload,
  scope: CredentialScope,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  try {
    const ack = await deps.exposureRedemptionClaims.acknowledge(claimInput);
    const holdoverFault = await ensureHoldoverWrite(ticket, scope, exposureId, deps);
    if (holdoverFault) return holdoverFault;
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
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  const exposure = await assembleExposureFromTicket({
    ticket,
    appId: claimInput.appId,
    environmentId: claimInput.environmentId,
    exposureId: item.exposureId,
    clientTimestamp: item.clientTimestamp,
    sourceId: deps.sourceId,
    now: deps.now ?? deps.exposureTicket.now,
  });

  try {
    await deps.exposureIngestSink.write(exposure);
  } catch (cause) {
    await releaseClaimQuietly(claimInput, deps);
    if (cause instanceof ExposureIngestSinkError) {
      deps.logger?.error("exposure_ingest_sink_failed", {
        requestId: claimInput.requestId,
        status: cause.status,
        appId: claimInput.appId,
        environmentId: claimInput.environmentId,
        exposureId: item.exposureId,
        causeChain: errorCauseChain(cause),
      });
      return rejected(item.exposureId, ingestFailureCode(cause.status));
    }
    deps.logger?.error("exposure_ingest_sink_failed", {
      requestId: claimInput.requestId,
      appId: claimInput.appId,
      environmentId: claimInput.environmentId,
      exposureId: item.exposureId,
      causeChain: errorCauseChain(cause),
    });
    // Deliberate: unclassified ingest throws are platform-side and retryable.
    // Claim-store faults must not use this branch — they go through
    // logAndRejectClaimStoreFault so taxonomy cannot regress per call site.
    return rejected(item.exposureId, RETRYABLE_EXPOSURE_REJECTION_CODE);
  }

  try {
    await deps.exposureRedemptionClaims.markSealed(claimInput);
    const ack = await deps.exposureRedemptionClaims.acknowledge(claimInput);
    const holdoverFault = await ensureHoldoverWrite(ticket, scope, item.exposureId, deps);
    if (holdoverFault) return holdoverFault;
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
