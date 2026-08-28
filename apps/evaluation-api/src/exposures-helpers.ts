import type { ErrorCode, ExposureBatchResult } from "@splitch/contracts";
import { RETRYABLE_EXPOSURE_REJECTION_CODE } from "@splitch/contracts";
import type { AppIdentityAdmission } from "./app-identity-traffic";
import type { HoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import { errorCauseChain } from "./error-cause-chain";
import {
  type ExposureTicketPayload,
  type MintExposureTicketDeps,
  verifyExposureTicket,
} from "./evaluate/exposure-ticket";
import { rejectClaimStoreFault } from "./exposure-claim-fault";
import type { ExposureRedemptionClaimInput } from "./exposure-redemption-claim-core";
import type { CredentialScope } from "./exposures-request";

export type RedemptionClaimContext = ExposureRedemptionClaimInput & { readonly requestId: string };

export function rejected(exposureId: string, code: ErrorCode): ExposureBatchResult {
  return { exposureId, status: "rejected", code };
}

/** Log + classify claim-store throws — the only path that maps cause → rejection code. */
export function logAndRejectClaimStoreFault(
  message: string,
  exposureId: string,
  claimInput: RedemptionClaimContext,
  cause: unknown,
  deps: { readonly logger?: { error(message: string, detail: unknown): void } },
): ExposureBatchResult {
  deps.logger?.error(message, {
    requestId: claimInput.requestId,
    appId: claimInput.appId,
    environmentId: claimInput.environmentId,
    exposureId,
    causeChain: errorCauseChain(cause),
  });
  return rejectClaimStoreFault(exposureId, cause);
}

const CALLER_FAULT_INGEST_STATUSES = new Set([400]);

export function ingestFailureCode(status: number | null): ErrorCode {
  if (status !== null && CALLER_FAULT_INGEST_STATUSES.has(status)) {
    return "VALIDATION_ERROR";
  }
  return RETRYABLE_EXPOSURE_REJECTION_CODE;
}

export async function verifyTicketForScope(
  ticket: string,
  scope: CredentialScope,
  admission: AppIdentityAdmission,
  deps: {
    readonly exposureTicket: MintExposureTicketDeps & { readonly previousTicketKey?: string };
    readonly now?: () => Date;
  },
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
  if (admission.identityVersion !== verified.payload.identity_version) {
    return { ok: false, code: "EXPOSURE_TICKET_INVALID" };
  }
  return { ok: true, payload: verified.payload };
}

export async function releaseClaimQuietly(
  claimInput: RedemptionClaimContext,
  deps: {
    readonly exposureRedemptionClaims: {
      release(input: ExposureRedemptionClaimInput): Promise<void>;
    };
    readonly logger?: { error(message: string, detail: unknown): void };
  },
): Promise<void> {
  try {
    await deps.exposureRedemptionClaims.release(claimInput);
  } catch (cause) {
    deps.logger?.error("exposure_redemption_release_failed", {
      requestId: claimInput.requestId,
      appId: claimInput.appId,
      environmentId: claimInput.environmentId,
      exposureId: claimInput.exposureId,
      causeChain: errorCauseChain(cause),
    });
  }
}

/**
 * Completes the Assignment Store holdover or durably owns retry before the
 * caller may report `accepted` (SPL-346). Returns a transient rejection when
 * ownership cannot be sealed so the SDK retains the queue item. Exhausted
 * (poisoned) retries fail loud as non-retryable INTERNAL_SERVER_ERROR so a
 * resume-ack cannot acknowledge with no completion and no retry left.
 * Deletion-cutoff `suppressed` is an explicit non-success batch status — never
 * silent holdover completion.
 */
export async function ensureHoldoverWrite(
  ticket: {
    readonly experiment_id: string;
    readonly id_type: string;
    readonly targeting_key_hash: string;
    readonly run_id: string;
    readonly variant: string;
    readonly issued_at: string;
  },
  scope: CredentialScope,
  exposureId: string,
  deps: {
    readonly holdoverWrite: HoldoverWriteCoordinator;
    readonly logger?: { error(message: string, detail: unknown): void };
  },
): Promise<ExposureBatchResult | null> {
  try {
    const sourceCreatedAtMs = Date.parse(ticket.issued_at);
    const result = await deps.holdoverWrite.ensure(
      {
        appId: scope.appId,
        experimentId: ticket.experiment_id,
        idType: ticket.id_type,
        targetingKeyHash: ticket.targeting_key_hash,
        runId: ticket.run_id,
        variant: ticket.variant,
      },
      {
        sourceCreatedAtMs: Number.isFinite(sourceCreatedAtMs) ? sourceCreatedAtMs : undefined,
      },
    );
    if (result.status === "poisoned") {
      deps.logger?.error("holdover_write_retry_exhausted_at_ack", {
        appId: scope.appId,
        experimentId: ticket.experiment_id,
        idType: ticket.id_type,
        targetingKeyHash: ticket.targeting_key_hash,
        runId: ticket.run_id,
        variant: ticket.variant,
        exposureId,
      });
      return rejected(exposureId, "INTERNAL_SERVER_ERROR");
    }
    if (result.status === "suppressed") {
      return { exposureId, status: "suppressed", code: null };
    }
    return null;
  } catch (cause) {
    deps.logger?.error("holdover_write_ensure_failed", {
      appId: scope.appId,
      experimentId: ticket.experiment_id,
      idType: ticket.id_type,
      targetingKeyHash: ticket.targeting_key_hash,
      runId: ticket.run_id,
      variant: ticket.variant,
      exposureId,
      causeChain: errorCauseChain(cause),
    });
    return rejected(exposureId, RETRYABLE_EXPOSURE_REJECTION_CODE);
  }
}
