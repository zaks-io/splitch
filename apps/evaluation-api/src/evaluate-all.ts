import {
  type ErrorResponse,
  type EvaluateAllEntry,
  type EvaluateAllRequest,
  EvaluateAllResponseSchema,
} from "@splitch/contracts";
import { type HandlerArgs, type Principal, renderError } from "@splitch/worker-runtime";
import {
  type AppIdentityAdmission,
  admittedAssignmentStore,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "./app-identity-traffic";
import { memoizeGetAll } from "./assignment/memoize-get-all";
import { evaluateAllFlag } from "./evaluate/accessor-paths";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types";
import {
  exposureTicketRefreshWindow,
  type MintExposureTicketDeps,
} from "./evaluate/exposure-ticket";
import { entryFor } from "./evaluate-all-entry";
import { etagMaterial, ifNoneMatchMatches, strongEtag } from "./evaluate-all-exposure-identity";
import { sdkRuntime } from "./evaluate-response";
import { evaluateAllRouteInput } from "./evaluation-route-input";
import type { EvaluationCommitSink } from "./evaluation-commit-sink";
import { EvaluationCommitSinkError } from "./evaluation-commit-sink";
import { errorResponse } from "./evaluation-error-response";
import type { EvaluationUsageScope } from "./evaluation-usage";
import type { FlagConfig } from "./provider/provider";

/**
 * Batch Flag Key used on the Evaluation usage row for an evaluate-all fetch.
 * Per-Flag breakdown for batches is a reporting concern on `is_batch` + count;
 * the Idempotency-Key is the single billing replay identity (ADR-0033).
 */
const BATCH_USAGE_FLAG_KEY = "*";

interface EvaluateAllRouteDeps extends EvaluatePathDeps {
  readonly evaluationCommitSink: EvaluationCommitSink;
  readonly exposureTicket: MintExposureTicketDeps;
}

type CredentialScope = EvaluationUsageScope;

export function makeEvaluateAllHandler(deps: EvaluateAllRouteDeps) {
  return async ({
    input,
    principal,
    requestId,
    request,
  }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = evaluateAllRouteInput(input);
    const checked = await checkedEvaluationScope(
      principal,
      parsed.body.appId,
      deps.exposureTicket.saltStore,
      requestId,
    );
    if (!checked.ok) return checked.response;
    const { scope, admission } = checked;
    const requestDeps = admittedEvaluateAllDeps(deps, admission);
    return completeEvaluateAll(parsed.body, scope, request, requestId, requestDeps, admission);
  };
}

async function completeEvaluateAll(
  requestBody: EvaluateAllRequest,
  scope: CredentialScope,
  request: Request,
  requestId: string,
  deps: EvaluateAllRouteDeps,
  admission: AppIdentityAdmission,
): Promise<Response> {
  const payload = await resolveAll(requestBody, scope, deps);
  if (!payload.ok) return renderError(payload.error, { requestId });

  const body = EvaluateAllResponseSchema.parse({ evaluations: payload.evaluations });
  const etag = await strongEtag(
    etagMaterial(
      body,
      {
        appId: scope.appId,
        environmentId: scope.environmentId,
        targetingKey: requestBody.targetingKey,
        idType: requestBody.idType,
        attributes: requestBody.attributes,
      },
      payload.ticketRefreshWindow,
    ),
  );
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    const staleBeforeSuccess = await appIdentityAdmissionValidationError(admission);
    if (staleBeforeSuccess !== null) return renderError(staleBeforeSuccess, { requestId });
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "access-control-expose-headers": "etag, x-request-id",
      },
    });
  }

  const billed = await writeBatchUsage(body, scope, request, deps, admission);
  if (!billed.ok) return renderError(billed.error, { requestId });

  const staleBeforeSuccess = await appIdentityAdmissionValidationError(admission);
  if (staleBeforeSuccess !== null) return renderError(staleBeforeSuccess, { requestId });

  return Response.json(body, {
    headers: {
      etag,
      "access-control-expose-headers": "etag, x-request-id",
    },
  });
}

async function checkedEvaluationScope(
  principal: Principal,
  assertedAppId: string | undefined,
  saltStore: MintExposureTicketDeps["saltStore"],
  requestId: string,
): Promise<
  | { ok: true; scope: CredentialScope; admission: AppIdentityAdmission }
  | { ok: false; response: Response }
> {
  const scope = credentialScope(principal);
  if (!scope.ok) return { ok: false, response: renderError(scope.error, { requestId }) };
  const assertionError = appAssertionError(assertedAppId, scope.value.appId);
  if (assertionError !== null) {
    return { ok: false, response: renderError(assertionError, { requestId }) };
  }
  const admitted = await tryAdmitAppIdentity(saltStore, scope.value.appId);
  return admitted.ok
    ? { ok: true, scope: scope.value, admission: admitted.admission }
    : { ok: false, response: renderError(admitted.error, { requestId }) };
}

async function resolveAll(
  body: EvaluateAllRequest,
  scope: CredentialScope,
  deps: EvaluateAllRouteDeps,
): Promise<
  | {
      ok: true;
      evaluations: Record<string, EvaluateAllEntry>;
      ticketRefreshWindow: number | null;
    }
  | { ok: false; error: ErrorResponse }
> {
  let flags: FlagConfig[];
  try {
    flags = await deps.provider.getFlags(scope.appId, scope.environmentId);
  } catch (cause) {
    deps.logger?.error("evaluate_all_get_flags_failed", { cause });
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "provider config is temporarily unavailable"),
    };
  }

  const assignmentStore = memoizeGetAll(deps.assignmentStore);
  const pathDeps: EvaluatePathDeps = { ...deps, assignmentStore };
  const ticketNow = (deps.exposureTicket.now ?? (() => new Date()))();
  const ticketDeps: MintExposureTicketDeps = {
    ...deps.exposureTicket,
    now: () => ticketNow,
  };
  if (flags.some((flag) => flag.flagKey === "__proto__")) {
    return {
      ok: false,
      error: errorResponse(
        "UNSUPPORTED_OBJECT_KEY",
        'Flag Key "__proto__" cannot be included in Precomputed Evaluations',
      ),
    };
  }

  const entries = await Promise.all(
    flags.map(async (flag) => {
      const routeInput: EvaluatePathInput = {
        appId: scope.appId,
        environmentId: scope.environmentId,
        flagKey: flag.flagKey,
        evaluationContext: {
          targetingKey: body.targetingKey,
          idType: body.idType,
          attributes: body.attributes,
        },
      };
      const output = await evaluateAllFlag(routeInput, pathDeps);
      const entry = await entryFor(output.result, flag, ticketDeps);
      return [flag.flagKey, entry] as const;
    }),
  );
  const evaluations = Object.fromEntries(entries) as Record<string, EvaluateAllEntry>;
  const hasExposureTicket = entries.some(([, entry]) => entry.exposureTicket !== null);

  return {
    ok: true,
    evaluations,
    ticketRefreshWindow: hasExposureTicket ? exposureTicketRefreshWindow(ticketNow) : null,
  };
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

function appAssertionError(appId: string | undefined, scopedAppId: string): ErrorResponse | null {
  return appId !== undefined && appId !== scopedAppId
    ? errorResponse("APP_MISMATCH", "credential does not belong to appId")
    : null;
}

async function writeBatchUsage(
  body: ReturnType<typeof EvaluateAllResponseSchema.parse>,
  scope: CredentialScope,
  request: Request,
  deps: EvaluateAllRouteDeps,
  admission: AppIdentityAdmission,
): Promise<{ ok: true } | { ok: false; error: ErrorResponse }> {
  const flagCount = Object.keys(body.evaluations).length;
  if (flagCount === 0) return { ok: true };

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null) {
    return {
      ok: false,
      error: errorResponse("VALIDATION_ERROR", "Idempotency-Key is required for Evaluation usage"),
    };
  }

  const stale = await appIdentityAdmissionValidationError(admission);
  if (stale !== null) return { ok: false, error: stale };

  try {
    await deps.evaluationCommitSink.write({
      usage: {
        idempotencyKey,
        organizationId: scope.organizationId,
        appId: scope.appId,
        identityVersion: admission.identityVersion,
        environmentId: scope.environmentId,
        flagKey: BATCH_USAGE_FLAG_KEY,
        sdkRuntime: sdkRuntime(request),
        evaluationCount: flagCount,
        isBatch: true,
        isCached: false,
        hasExposure: false,
      },
      exposures: [],
    });
    return { ok: true };
  } catch (cause) {
    if (!(cause instanceof EvaluationCommitSinkError)) throw cause;
    deps.logger?.error("evaluate_all_usage_sink_failed", { cause });
    return {
      ok: false,
      error: errorResponse(
        "SERVICE_UNAVAILABLE",
        "evaluation usage commit is temporarily unavailable",
      ),
    };
  }
}

function admittedEvaluateAllDeps(
  deps: EvaluateAllRouteDeps,
  admission: AppIdentityAdmission,
): EvaluateAllRouteDeps {
  return {
    ...deps,
    assignmentStore: admittedAssignmentStore(deps.assignmentStore, admission),
    exposureTicket: { ...deps.exposureTicket, saltStore: admission.saltStore },
  };
}
