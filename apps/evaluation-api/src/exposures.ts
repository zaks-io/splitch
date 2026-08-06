import {
  type ErrorCode,
  type ErrorResponse,
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  type ExposureBatchRequest,
  ExposureBatchResponseSchema,
  type ExposureBatchResult,
} from "@splitch/contracts";
import { type HandlerArgs, type Principal, renderError } from "@splitch/worker-runtime";
import type { AssignmentStore } from "./assignment/assignment-store";
import { assembleExposureFromTicket } from "./evaluate/exposure-assembly";
import {
  type ExposureTicketPayload,
  type MintExposureTicketDeps,
  verifyExposureTicket,
} from "./evaluate/exposure-ticket";
import { errorResponse } from "./evaluation-error-response";
import {
  type ExposureIngestSink,
  ExposureIngestSinkError,
  type ExposureRedemptionClaimStore,
  ticketFingerprint,
} from "./exposure-redemption";

interface ExposuresRouteDeps {
  readonly assignmentStore: AssignmentStore;
  readonly exposureIngestSink: ExposureIngestSink;
  readonly exposureRedemptionClaims: ExposureRedemptionClaimStore;
  readonly exposureTicket: MintExposureTicketDeps & {
    readonly previousTicketKey?: string;
  };
  readonly sourceId: string;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly logger?: { error(message: string, detail: unknown): void };
  readonly now?: () => Date;
}

type CredentialScope = {
  readonly organizationId: string;
  readonly appId: string;
  readonly environmentId: string;
};

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
      results.push(await redeemOne(item, scope.value, deps));
    }

    return Response.json(ExposureBatchResponseSchema.parse({ results }), { status: 202 });
  };
}

async function redeemOne(
  item: ExposureBatchRequest["exposures"][number],
  scope: CredentialScope,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult> {
  const verified = await verifyTicketForScope(item.exposureTicket, scope, deps);
  if (!verified.ok) return rejected(item.exposureId, verified.code);

  const fingerprint = await ticketFingerprint(item.exposureTicket);
  const claim = await claimLookup(item.exposureId, fingerprint, scope, deps);
  if (claim !== null) return claim;

  const sealed = await sealAndRecord(item, verified.payload, fingerprint, scope, deps);
  if (!sealed.ok) return rejected(item.exposureId, sealed.code);

  scheduleHoldoverWrite(verified.payload, scope, deps);
  return { exposureId: item.exposureId, status: "accepted", code: null };
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

async function claimLookup(
  exposureId: string,
  fingerprint: string,
  scope: CredentialScope,
  deps: ExposuresRouteDeps,
): Promise<ExposureBatchResult | null> {
  const existing = await deps.exposureRedemptionClaims.lookup({
    appId: scope.appId,
    environmentId: scope.environmentId,
    exposureId,
    ticketFingerprint: fingerprint,
  });
  if (existing.status === "conflict") {
    return rejected(exposureId, "EVENT_ID_CONFLICT");
  }
  if (existing.status === "matched") {
    return { exposureId, status: "deduplicated", code: null };
  }
  return null;
}

async function sealAndRecord(
  item: ExposureBatchRequest["exposures"][number],
  ticket: ExposureTicketPayload,
  fingerprint: string,
  scope: CredentialScope,
  deps: ExposuresRouteDeps,
): Promise<{ ok: true } | { ok: false; code: ErrorCode }> {
  const exposure = await assembleExposureFromTicket({
    ticket,
    appId: scope.appId,
    environmentId: scope.environmentId,
    exposureId: item.exposureId,
    clientTimestamp: item.clientTimestamp,
    sourceId: deps.sourceId,
    now: deps.now ?? deps.exposureTicket.now,
  });

  try {
    await deps.exposureIngestSink.write(exposure);
    await deps.exposureRedemptionClaims.record({
      appId: scope.appId,
      environmentId: scope.environmentId,
      exposureId: item.exposureId,
      ticketFingerprint: fingerprint,
    });
    return { ok: true };
  } catch (cause) {
    if (cause instanceof ExposureIngestSinkError) {
      deps.logger?.error("exposure_ingest_sink_failed", {
        status: cause.status,
        appId: scope.appId,
        environmentId: scope.environmentId,
        exposureId: item.exposureId,
        causeSummary: cause.message,
      });
      return { ok: false, code: ingestFailureCode(cause.status) };
    }
    deps.logger?.error("exposure_redemption_claim_failed", {
      appId: scope.appId,
      environmentId: scope.environmentId,
      exposureId: item.exposureId,
      causeSummary: cause instanceof Error ? cause.message : String(cause),
    });
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

/** Only genuine caller-fault ingest statuses map to permanent VALIDATION_ERROR. */
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

async function assertBodyWithinCap(
  request: Request,
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: ErrorResponse }> {
  const bytes = await utf8BodyByteLength(request, input);
  if (bytes <= EXPOSURE_BATCH_MAX_BODY_BYTES) return { ok: true };
  return {
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message: `Exposure batch body exceeds ${EXPOSURE_BATCH_MAX_BODY_BYTES} UTF-8 bytes`,
      details: {
        issues: [
          {
            path: ["body"],
            message: `body must be at most ${EXPOSURE_BATCH_MAX_BODY_BYTES} UTF-8 bytes`,
          },
        ],
      },
    },
  };
}

async function utf8BodyByteLength(request: Request, input: unknown): Promise<number> {
  try {
    const buffer = await request.clone().arrayBuffer();
    if (buffer.byteLength > 0) return buffer.byteLength;
  } catch {
    // Stream unavailable — fall through.
  }
  const root = asRecord(input);
  const body = root?.body ?? input;
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

function exposureBatchBody(
  input: unknown,
): { ok: true; value: ExposureBatchRequest } | { ok: false; error: ErrorResponse } {
  const root = asRecord(input);
  const body = root?.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("exposures" in body) ||
    !Array.isArray((body as { exposures: unknown }).exposures)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Exposure batch body is required",
        details: { issues: [{ path: ["body"], message: "exposures is required" }] },
      },
    };
  }
  return { ok: true, value: body as ExposureBatchRequest };
}

function credentialScope(
  principal: Principal,
): { ok: true; value: CredentialScope } | { ok: false; error: ErrorResponse } {
  if (principal.orgId === null || principal.appId === null || principal.environmentId === null) {
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "credential cache migration is required"),
    };
  }
  return {
    ok: true,
    value: {
      organizationId: principal.orgId,
      appId: principal.appId,
      environmentId: principal.environmentId,
    },
  };
}

function rejected(exposureId: string, code: ErrorCode): ExposureBatchResult {
  return { exposureId, status: "rejected", code };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
