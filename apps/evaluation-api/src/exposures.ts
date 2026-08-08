import {
  type ErrorCode,
  type ExposureBatchRequest,
  ExposureBatchResponseSchema,
  type ExposureBatchResult,
} from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import type { AssignmentStore } from "./assignment/assignment-store";
import { assembleExposureFromTicket } from "./evaluate/exposure-assembly";
import {
  type ExposureTicketPayload,
  type MintExposureTicketDeps,
  verifyExposureTicket,
} from "./evaluate/exposure-ticket";
import {
  type ExposureIngestSink,
  ExposureIngestSinkError,
  ticketFingerprint,
} from "./exposure-redemption";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import {
  assertBodyWithinCap,
  type CredentialScope,
  credentialScope,
  exposureBatchBody,
} from "./exposures-request";

interface ExposuresRouteDeps {
  readonly assignmentStore: AssignmentStore;
  readonly exposureIngestSink: ExposureIngestSink;
  readonly exposureRedemptionClaims: ExposureRedemptionClaimStore;
  readonly exposureTicket: MintExposureTicketDeps & { readonly previousTicketKey?: string };
  readonly sourceId: string;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly logger?: { error(message: string, detail: unknown): void };
  readonly now?: () => Date;
}

type RedemptionClaimContext = ExposureRedemptionClaimInput & { readonly requestId: string };

export function makeExposuresHandler(deps: ExposuresRouteDeps) {
  return async ({
    input,
    principal,
    requestId,
    request,
  }: HandlerArgs<unknown>): Promise<Response> => {
    const scope = credentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });

    const bodyCheck = await assertBodyWithinCap(request, input);
    if (!bodyCheck.ok) return renderError(bodyCheck.error, { requestId });

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
    deps.logger?.error("exposure_redemption_claim_failed", {
      requestId: claimInput.requestId,
      appId: scope.appId,
      environmentId: scope.environmentId,
      exposureId: item.exposureId,
      causeSummary: cause instanceof Error ? cause.message : String(cause),
    });
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE");
  }

  if (claim.status === "conflict") {
    return rejected(item.exposureId, "EVENT_ID_CONFLICT");
  }
  if (claim.status === "busy") {
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE");
  }
  if (claim.status === "deduplicated") {
    scheduleHoldoverWrite(verified.payload, scope, deps);
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
    scheduleHoldoverWrite(ticket, scope, deps);
    return {
      exposureId,
      status: ack.status === "already_accepted" ? "deduplicated" : "accepted",
      code: null,
    };
  } catch (cause) {
    deps.logger?.error("exposure_redemption_acknowledge_failed", {
      requestId: claimInput.requestId,
      appId: claimInput.appId,
      environmentId: claimInput.environmentId,
      exposureId,
      causeSummary: cause instanceof Error ? cause.message : String(cause),
    });
    scheduleHoldoverWrite(ticket, scope, deps);
    return rejected(exposureId, "SERVICE_UNAVAILABLE");
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
        status: cause.status,
        appId: claimInput.appId,
        environmentId: claimInput.environmentId,
        exposureId: item.exposureId,
        causeSummary: cause.message,
      });
      return rejected(item.exposureId, ingestFailureCode(cause.status));
    }
    deps.logger?.error("exposure_ingest_sink_failed", {
      appId: claimInput.appId,
      environmentId: claimInput.environmentId,
      exposureId: item.exposureId,
      causeSummary: cause instanceof Error ? cause.message : String(cause),
    });
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE");
  }

  try {
    await deps.exposureRedemptionClaims.markSealed(claimInput);
    const ack = await deps.exposureRedemptionClaims.acknowledge(claimInput);
    scheduleHoldoverWrite(ticket, scope, deps);
    return {
      exposureId: item.exposureId,
      status: ack.status === "already_accepted" ? "deduplicated" : "accepted",
      code: null,
    };
  } catch (cause) {
    deps.logger?.error("exposure_redemption_confirm_failed", {
      requestId: claimInput.requestId,
      appId: claimInput.appId,
      environmentId: claimInput.environmentId,
      exposureId: item.exposureId,
      causeSummary: cause instanceof Error ? cause.message : String(cause),
    });
    // Ingest committed. If markSealed succeeded, exact-ID retry uses resume_ack
    // (no second append). If markSealed failed, the claim stays pending until
    // EXPOSURE_REDEMPTION_PENDING_LEASE_MS — then a retry may re-acquire and
    // append again (accepted ambiguous-window risk; see that constant).
    scheduleHoldoverWrite(ticket, scope, deps);
    return rejected(item.exposureId, "SERVICE_UNAVAILABLE");
  }
}

async function releaseClaimQuietly(
  claimInput: RedemptionClaimContext,
  deps: ExposuresRouteDeps,
): Promise<void> {
  try {
    await deps.exposureRedemptionClaims.release(claimInput);
  } catch (cause) {
    deps.logger?.error("exposure_redemption_release_failed", {
      requestId: claimInput.requestId,
      appId: claimInput.appId,
      environmentId: claimInput.environmentId,
      exposureId: claimInput.exposureId,
      causeSummary: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function verifyTicketForScope(
  ticket: string,
  scope: CredentialScope,
  deps: ExposuresRouteDeps,
): Promise<{ ok: true; payload: ExposureTicketPayload } | { ok: false; code: ErrorCode }> {
  const verified = await verifyExposureTicket(ticket, {
    ticketKey: deps.exposureTicket.ticketKey,
    previousTicketKey: deps.exposureTicket.previousTicketKey,
    now: deps.now ?? deps.exposureTicket.now,
  });
  if (!verified.ok) {
    return {
      ok: false,
      code: verified.reason === "expired" ? "EXPOSURE_TICKET_EXPIRED" : "EXPOSURE_TICKET_INVALID",
    };
  }
  if (
    verified.payload.app_id !== scope.appId ||
    verified.payload.environment_id !== scope.environmentId
  ) {
    return { ok: false, code: "EXPOSURE_TICKET_INVALID" };
  }
  return { ok: true, payload: verified.payload };
}

const CALLER_FAULT_INGEST_STATUSES = new Set([400]);

function ingestFailureCode(status: number | null): ErrorCode {
  if (status !== null && CALLER_FAULT_INGEST_STATUSES.has(status)) {
    return "VALIDATION_ERROR";
  }
  return "SERVICE_UNAVAILABLE";
}

function scheduleHoldoverWrite(
  ticket: {
    readonly experiment_id: string;
    readonly id_type: string;
    readonly targeting_key_hash: string;
    readonly run_id: string;
    readonly variant: string;
  },
  scope: CredentialScope,
  deps: ExposuresRouteDeps,
): void {
  const write = deps.assignmentStore
    .putHashed({
      appId: scope.appId,
      experimentId: ticket.experiment_id,
      idType: ticket.id_type,
      targetingKeyHash: ticket.targeting_key_hash,
      runId: ticket.run_id,
      variant: ticket.variant,
    })
    .then(
      () => undefined,
      (cause) => {
        deps.logger?.error("assignment_store_put_failed", { cause });
      },
    );
  deps.waitUntil?.(write);
}

function rejected(exposureId: string, code: ErrorCode): ExposureBatchResult {
  return { exposureId, status: "rejected", code };
}
