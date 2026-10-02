import {
  type ErrorResponse,
  type EvaluateAllRequest,
  EvaluateAllResponseSchema,
} from "@splitch/contracts";
import {
  noopPerformanceSpanRecorder,
  type PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import { type HandlerArgs, type Principal, renderError } from "@splitch/worker-runtime";
import {
  type AppIdentityAdmission,
  admittedAssignmentStore,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "./app-identity-traffic";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path-types";
import type { MintExposureTicketDeps } from "./evaluate/exposure-ticket";
import { etagMaterial, ifNoneMatchMatches, strongEtag } from "./evaluate-all-exposure-identity";
import { resolveAllEvaluations } from "./evaluate-all-resolve";
import { writeEvaluateAllUsage } from "./evaluate-all-usage";
import { evaluateAllRouteInput } from "./evaluation-route-input";
import type { EvaluationCommitSink } from "./evaluation-commit-sink";
import { errorResponse } from "./evaluation-error-response";
import type { EvaluationUsageScope } from "./evaluation-usage";

interface EvaluateAllRouteDeps extends EvaluatePathDeps {
  readonly evaluationCommitSink: EvaluationCommitSink;
  readonly exposureTicket: MintExposureTicketDeps;
  readonly spans?: PerformanceSpanRecorder;
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
    const spans = deps.spans ?? noopPerformanceSpanRecorder;
    const checked = await spans.record(
      { name: "Evaluate-all identity admission", op: "auth" },
      () =>
        checkedEvaluationScope(
          principal,
          parsed.body.appId,
          deps.exposureTicket.saltStore,
          requestId,
        ),
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
  const payload = await (deps.spans ?? noopPerformanceSpanRecorder).record(
    { name: "Evaluate-all resolution", op: "function" },
    () => resolveAllEvaluations(requestBody, scope, deps),
  );
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

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null) {
    return renderError(
      errorResponse("VALIDATION_ERROR", "Idempotency-Key is required for Evaluation usage"),
      { requestId },
    );
  }
  const billed = await writeEvaluateAllUsage(body, scope, request, deps, admission, idempotencyKey);
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
