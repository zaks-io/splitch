import type { ErrorCode, ExposureBatchResult } from "@splitch/contracts";
import type { AssignmentStore } from "./assignment/assignment-store";
import { errorCauseChain } from "./error-cause-chain";
import {
  type ExposureTicketPayload,
  type MintExposureTicketDeps,
  verifyExposureTicket,
} from "./evaluate/exposure-ticket";
import type { ExposureRedemptionClaimInput } from "./exposure-redemption-claim-core";
import type { CredentialScope } from "./exposures-request";

export type ExposuresHoldoverDeps = {
  readonly assignmentStore: AssignmentStore;
  readonly exposureTicket: MintExposureTicketDeps & { readonly previousTicketKey?: string };
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly logger?: { error(message: string, detail: unknown): void };
  readonly now?: () => Date;
};

export type RedemptionClaimContext = ExposureRedemptionClaimInput & { readonly requestId: string };

const CALLER_FAULT_INGEST_STATUSES = new Set([400]);

export function ingestFailureCode(status: number | null): ErrorCode {
  if (status !== null && CALLER_FAULT_INGEST_STATUSES.has(status)) {
    return "VALIDATION_ERROR";
  }
  return "SERVICE_UNAVAILABLE";
}

export function rejected(exposureId: string, code: ErrorCode): ExposureBatchResult {
  return { exposureId, status: "rejected", code };
}

export async function verifyTicketForScope(
  ticket: string,
  scope: CredentialScope,
  deps: ExposuresHoldoverDeps,
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

export function scheduleHoldoverWrite(
  ticket: {
    readonly experiment_id: string;
    readonly id_type: string;
    readonly targeting_key_hash: string;
    readonly run_id: string;
    readonly variant: string;
  },
  scope: CredentialScope,
  deps: ExposuresHoldoverDeps,
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
