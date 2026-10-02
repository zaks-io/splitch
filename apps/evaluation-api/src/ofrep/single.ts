import { type ErrorResponse, OfrepEvaluationSuccessSchema } from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import {
  type AppIdentityAdmission,
  admittedAssignmentStore,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "../app-identity-traffic";
import { evaluate } from "../evaluate/accessor-paths";
import type { EvaluatePathDeps, EvaluatePathInput } from "../evaluate/evaluate-path-types";
import type { AssembledExposure, ExposureAssemblyDeps } from "../evaluate/exposure-assembly";
import { resolutionEntry } from "../evaluate-all-entry";
import { sdkRuntime } from "../evaluate-response";
import type { EvaluationCommitSink } from "../evaluation-commit-sink";
import { EvaluationCommitSinkError } from "../evaluation-commit-sink";
import { errorResponse } from "../evaluation-error-response";
import type { EvaluationUsageScope } from "../evaluation-usage";
import { CapturingProvider } from "../provider/capturing-provider";
import { parseOfrepContext } from "./context";
import { ofrepFlagNotFound, ofrepRequestFailure, ofrepServerError } from "./errors";
import { mapEvaluateAllEntry } from "./map-flag";
import { billingIdempotencyKey, ofrepCredentialScope } from "./scope";

interface OfrepSingleDeps extends EvaluatePathDeps {
  readonly exposureAssembly: ExposureAssemblyDeps;
  readonly evaluationCommitSink: EvaluationCommitSink;
}

export function makeOfrepEvaluateHandler(deps: OfrepSingleDeps) {
  return async ({
    input,
    principal,
    requestId,
    request,
  }: HandlerArgs<unknown>): Promise<Response> => {
    const key = ofrepFlagKey(input);
    const parsed = parseOfrepContext(record(input).body);
    if (!parsed.ok) return ofrepRequestFailure(parsed.errorCode, parsed.errorDetails, key);
    const scope = ofrepCredentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });
    const admitted = await tryAdmitAppIdentity(deps.exposureAssembly.saltStore, scope.value.appId);
    if (!admitted.ok) return renderError(admitted.error, { requestId });
    const requestDeps = admittedDeps(deps, admitted.admission);
    return completeOfrepEvaluate(
      key,
      parsed.request,
      scope.value,
      request,
      requestId,
      requestDeps,
      admitted.admission,
    );
  };
}

async function completeOfrepEvaluate(
  flagKey: string,
  body: EvaluatePathInput["evaluationContext"] & { targetingKey: string; idType: string },
  scope: EvaluationUsageScope,
  request: Request,
  requestId: string,
  deps: OfrepSingleDeps,
  admission: AppIdentityAdmission,
): Promise<Response> {
  const provider = new CapturingProvider(deps.provider);
  const output = await evaluate(
    {
      appId: scope.appId,
      environmentId: scope.environmentId,
      flagKey,
      evaluationContext: {
        targetingKey: body.targetingKey,
        idType: body.idType,
        attributes: body.attributes ?? {},
      },
    },
    { ...deps, provider },
    deps.exposureAssembly,
  );
  if (output.result.kind === "error" && output.result.errorCode === "FLAG_NOT_FOUND") {
    return ofrepFlagNotFound(flagKey);
  }
  if (provider.flag === null) {
    return ofrepServerError("flag config was not resolved");
  }
  const mapped = mapEvaluateAllEntry(flagKey, resolutionEntry(output.result, provider.flag));
  if ("errorCode" in mapped) {
    return ofrepRequestFailure(
      mapped.errorCode,
      mapped.errorDetails ?? "flag evaluation failed",
      flagKey,
    );
  }

  const commit = await writeSingleUsage(
    output.exposures,
    billingIdempotencyKey(request),
    scope,
    { flagKey, sdkRuntime: sdkRuntime(request) },
    deps,
    admission,
  );
  if (!commit.ok) return renderError(commit.error, { requestId });
  const stale = await appIdentityAdmissionValidationError(admission);
  if (stale !== null) return renderError(stale, { requestId });
  try {
    await writeHoldover(output.result, output.exposures, deps);
  } catch (cause) {
    deps.logger?.error("ofrep_assignment_store_put_failed", { cause });
    return renderError(
      errorResponse("SERVICE_UNAVAILABLE", "Assignment commit is temporarily unavailable"),
      { requestId },
    );
  }
  return Response.json(OfrepEvaluationSuccessSchema.parse(mapped));
}

async function writeHoldover(
  result: Awaited<ReturnType<typeof evaluate>>["result"],
  exposures: readonly AssembledExposure[],
  deps: OfrepSingleDeps,
): Promise<void> {
  const exposure = result.kind === "error" ? null : result.exposure;
  if (exposure === null) return;
  const sourceCreatedAtMs = Date.parse(exposures[0]?.exposureAt ?? "");
  if (!Number.isFinite(sourceCreatedAtMs)) {
    throw new Error("Assignment source timestamp is unavailable");
  }
  await deps.assignmentStore.put({
    appId: exposure.appId,
    idType: exposure.idType,
    targetingKey: exposure.targetingKey,
    experimentId: exposure.experimentId,
    runId: exposure.liveRunId,
    sourceCreatedAtMs,
    variant: exposure.variant,
  });
}

async function writeSingleUsage(
  exposures: readonly AssembledExposure[],
  idempotencyKey: string,
  scope: EvaluationUsageScope,
  dimensions: { readonly flagKey: string; readonly sdkRuntime: string },
  deps: OfrepSingleDeps,
  admission: AppIdentityAdmission,
): Promise<{ ok: true } | { ok: false; error: ErrorResponse }> {
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
        flagKey: dimensions.flagKey,
        sdkRuntime: dimensions.sdkRuntime,
        evaluationCount: 1,
        isBatch: false,
        isCached: false,
        hasExposure: exposures.length > 0,
      },
      exposures,
    });
    return { ok: true };
  } catch (cause) {
    if (!(cause instanceof EvaluationCommitSinkError)) throw cause;
    deps.logger?.error("ofrep_evaluation_commit_sink_failed", { cause });
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "Evaluation commit ingest is unavailable"),
    };
  }
}

function admittedDeps(deps: OfrepSingleDeps, admission: AppIdentityAdmission): OfrepSingleDeps {
  return {
    ...deps,
    assignmentStore: admittedAssignmentStore(deps.assignmentStore, admission),
    exposureAssembly: { ...deps.exposureAssembly, saltStore: admission.saltStore },
  };
}

function ofrepFlagKey(input: unknown): string {
  const params = record(record(input).params);
  const key = params.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("evaluation-api: missing OFREP flag key");
  }
  return key;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evaluation-api: expected parsed object input");
  }
  return value as Record<string, unknown>;
}
