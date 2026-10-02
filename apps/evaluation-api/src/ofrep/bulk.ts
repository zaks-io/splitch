import {
  type EvaluateAllRequest,
  EvaluateAllResponseSchema,
  OfrepBulkEvaluationSuccessSchema,
} from "@splitch/contracts";
import type { EvaluationUsageScope } from "../evaluation-usage";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import {
  type AppIdentityAdmission,
  admittedAssignmentStore,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "../app-identity-traffic";
import type { EvaluatePathDeps } from "../evaluate/evaluate-path-types";
import type { MintExposureTicketDeps } from "../evaluate/exposure-ticket";
import { etagMaterial, ifNoneMatchMatches, strongEtag } from "../evaluate-all-exposure-identity";
import { resolveAllEvaluations } from "../evaluate-all-resolve";
import { writeEvaluateAllUsage } from "../evaluate-all-usage";
import type { EvaluationCommitSink } from "../evaluation-commit-sink";
import { parseOfrepContext } from "./context";
import { ofrepRequestFailure } from "./errors";
import { mapEvaluateAllEntry } from "./map-flag";
import { billingIdempotencyKey, ofrepCredentialScope } from "./scope";

interface OfrepBulkDeps extends EvaluatePathDeps {
  readonly evaluationCommitSink: EvaluationCommitSink;
  readonly exposureTicket: MintExposureTicketDeps;
}

export function makeOfrepEvaluateBulkHandler(deps: OfrepBulkDeps) {
  return async ({
    input,
    principal,
    requestId,
    request,
  }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = parseOfrepContext(record(input).body);
    if (!parsed.ok) return ofrepRequestFailure(parsed.errorCode, parsed.errorDetails);
    const scope = ofrepCredentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });
    const admitted = await tryAdmitAppIdentity(deps.exposureTicket.saltStore, scope.value.appId);
    if (!admitted.ok) return renderError(admitted.error, { requestId });
    const requestDeps: OfrepBulkDeps = {
      ...deps,
      assignmentStore: admittedAssignmentStore(deps.assignmentStore, admitted.admission),
      exposureTicket: { ...deps.exposureTicket, saltStore: admitted.admission.saltStore },
    };
    return completeOfrepBulk(
      parsed.request,
      scope.value,
      request,
      requestId,
      requestDeps,
      admitted.admission,
    );
  };
}

async function completeOfrepBulk(
  requestBody: EvaluateAllRequest,
  scope: EvaluationUsageScope,
  request: Request,
  requestId: string,
  deps: OfrepBulkDeps,
  admission: AppIdentityAdmission,
): Promise<Response> {
  const payload = await resolveAllEvaluations(requestBody, scope, deps);
  if (!payload.ok) return renderError(payload.error, { requestId });

  const evaluations = EvaluateAllResponseSchema.parse({ evaluations: payload.evaluations });
  const ofrep = OfrepBulkEvaluationSuccessSchema.parse({
    flags: Object.entries(evaluations.evaluations).map(([key, entry]) =>
      mapEvaluateAllEntry(key, entry),
    ),
  });
  const etag = await strongEtag(
    etagMaterial(
      evaluations,
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
    const stale = await appIdentityAdmissionValidationError(admission);
    if (stale !== null) return renderError(stale, { requestId });
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "access-control-expose-headers": "etag, x-request-id",
      },
    });
  }

  const billed = await writeEvaluateAllUsage(
    evaluations,
    scope,
    request,
    deps,
    admission,
    billingIdempotencyKey(request),
  );
  if (!billed.ok) return renderError(billed.error, { requestId });
  const stale = await appIdentityAdmissionValidationError(admission);
  if (stale !== null) return renderError(stale, { requestId });
  return Response.json(ofrep, {
    headers: {
      etag,
      "access-control-expose-headers": "etag, x-request-id",
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evaluation-api: expected parsed object input");
  }
  return value as Record<string, unknown>;
}
