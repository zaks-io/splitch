import {
  type DataPlaneEvaluateRequest,
  DataPlaneEvaluateResponseSchema,
  type ErrorResponse,
} from "@splitch/contracts";
import { type HandlerArgs, type Principal, renderError } from "@splitch/worker-runtime";
import {
  type AppIdentityAdmission,
  admittedAssignmentStore,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "./app-identity-traffic";
import { evaluate } from "./evaluate/accessor-paths";
import type { EvaluateResult } from "./evaluate/evaluate-path";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types";
import type { AssembledExposure, ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import { responseBody, sdkRuntime } from "./evaluate-response";
import type { EvaluationCommitSink } from "./evaluation-commit-sink";
import { EvaluationCommitSinkError } from "./evaluation-commit-sink";
import { errorResponse } from "./evaluation-error-response";
import type { EvaluationUsageScope } from "./evaluation-usage";
import type { FlagConfig, Provider } from "./provider/provider";
import { reasonForResolution } from "./resolution-reason";

type EvaluateInput = {
  body: DataPlaneEvaluateRequest;
};

interface EvaluateRouteDeps extends EvaluatePathDeps {
  readonly exposureAssembly: ExposureAssemblyDeps;
  readonly evaluationCommitSink: EvaluationCommitSink;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

type CredentialScope = EvaluationUsageScope;

export function makeEvaluateHandler(deps: EvaluateRouteDeps) {
  return async ({
    input,
    principal,
    requestId,
    request,
  }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = evaluateInput(input);
    const scope = credentialScope(principal);
    if (!scope.ok) return renderError(scope.error, { requestId });

    const assertionError = appAssertionError(parsed.body.appId, scope.value.appId);
    if (assertionError !== null) return renderError(assertionError, { requestId });
    const admitted = await tryAdmitAppIdentity(deps.exposureAssembly.saltStore, scope.value.appId);
    if (!admitted.ok) return renderError(admitted.error, { requestId });

    const requestDeps = admittedEvaluateDeps(deps, admitted.admission);
    const evaluated = await evaluateWithCapture(parsed.body, scope.value, requestDeps);
    const stale = await appIdentityAdmissionValidationError(admitted.admission);
    if (stale !== null) return renderError(stale, { requestId });
    return evaluateResponse(evaluated, requestDeps, admitted.admission, requestId, request);
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
    ? errorResponse("APP_MISMATCH", "Client Key does not belong to appId")
    : null;
}

async function evaluateWithCapture(
  body: DataPlaneEvaluateRequest,
  scope: CredentialScope,
  deps: EvaluateRouteDeps,
) {
  const provider = new CapturingProvider(deps.provider);
  const routeInput: EvaluatePathInput = {
    appId: scope.appId,
    environmentId: scope.environmentId,
    flagKey: body.flagKey,
    evaluationContext: {
      targetingKey: body.targetingKey,
      idType: body.idType,
      attributes: body.attributes,
    },
  };
  const output = await evaluate(routeInput, { ...deps, provider }, deps.exposureAssembly);
  return { output, provider, scope };
}

async function evaluateResponse(
  evaluated: Awaited<ReturnType<typeof evaluateWithCapture>>,
  deps: EvaluateRouteDeps,
  admission: AppIdentityAdmission,
  requestId: string,
  request: Request,
): Promise<Response> {
  const { output, provider } = evaluated;
  if (output.result.kind === "error") {
    return renderError(errorResponse(output.result.errorCode, output.result.errorMessage), {
      requestId,
    });
  }
  if (provider.flag === null) {
    return renderError(errorResponse("INTERNAL_SERVER_ERROR", "flag config was not resolved"), {
      requestId,
    });
  }

  const body = responseBody(provider.flag, output.result);
  if (!body.ok) return renderError(body.error, { requestId });

  const logicalEvaluationId = request.headers.get("idempotency-key");
  if (logicalEvaluationId === null) {
    return renderError(
      errorResponse("VALIDATION_ERROR", "Idempotency-Key is required for Evaluation usage"),
      { requestId },
    );
  }

  const commit = await writeEvaluationCommit(
    output.exposures,
    logicalEvaluationId,
    evaluated.scope,
    { flagKey: provider.flag.flagKey, sdkRuntime: sdkRuntime(request) },
    deps,
    admission,
  );
  if (!commit.ok) return renderError(commit.error, { requestId });

  const stale = await appIdentityAdmissionValidationError(admission);
  if (stale !== null) return renderError(stale, { requestId });

  // Only record the holdover AFTER the Exposure is accepted by ingest. Writing it
  // first and then returning 503 would make the SDK retry hit holdover replay
  // without another Exposure, dropping the event. Writing it last lets retries
  // re-attempt the Exposure.
  try {
    await writeHoldoverAssignment(output.result, output.exposures, deps);
  } catch (cause) {
    deps.logger?.error("assignment_store_put_failed", { cause });
    return renderError(
      errorResponse("SERVICE_UNAVAILABLE", "Assignment commit is temporarily unavailable"),
      { requestId },
    );
  }
  const assignmentStale = await appIdentityAdmissionValidationError(admission);
  if (assignmentStale !== null) return renderError(assignmentStale, { requestId });

  const response = Response.json(DataPlaneEvaluateResponseSchema.parse(body.value));
  if (output.result.liveRunId !== null) {
    response.headers.set("x-run-id", output.result.liveRunId);
  }
  if (body.variantName !== null) {
    // Variant names are user-authored and unconstrained, but header values are
    // ByteStrings: a non-ASCII name would reach the SDK as mojibake, and one
    // containing CR/LF would make `set` throw here -- after the Exposure was
    // already committed, turning a served Evaluation into a 500. Percent-encoding
    // keeps this channel ASCII-safe for every name the contract admits.
    response.headers.set("x-variant-name", encodeURIComponent(body.variantName));
  }
  response.headers.set("x-reason", reasonForResolution(output.result));
  return response;
}

/**
 * The holdover write (holdover-write-contract.md): every result that fires an
 * Exposure records its first-touch `(run_id, variant)` in the Assignment Store
 * so a Run boundary replays the sticky Variant instead of re-assigning
 * (ADR-0006). The route waits for the durable winner because success cannot be
 * returned while an App identity reset could still reject the Assignment.
 * Holdover replays carry `exposure: null`, so they never re-write.
 */
async function writeHoldoverAssignment(
  result: EvaluateResult,
  exposures: readonly AssembledExposure[],
  deps: EvaluateRouteDeps,
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

async function writeEvaluationCommit(
  exposures: readonly AssembledExposure[],
  idempotencyKey: string,
  scope: EvaluationUsageScope,
  dimensions: { readonly flagKey: string; readonly sdkRuntime: string },
  deps: EvaluateRouteDeps,
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
    if (!(cause instanceof EvaluationCommitSinkError)) {
      throw cause;
    }
    // Flat, queryable fields: nesting the Error under `cause` reached the log
    // destination as "[object Object]", so the one signal that an Exposure was
    // dropped carried nothing to filter or alert on. No Targeting Key here --
    // the Entity identity never enters a log line.
    deps.logger?.error("evaluation_commit_sink_failed", {
      failure: cause.failure,
      status: cause.status,
      organizationId: scope.organizationId,
      appId: scope.appId,
      environmentId: scope.environmentId,
      flagKey: dimensions.flagKey,
      exposureCount: exposures.length,
      causeSummary: cause.cause instanceof Error ? cause.cause.message : cause.message,
    });
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "Evaluation commit ingest is unavailable"),
    };
  }
}

function admittedEvaluateDeps(
  deps: EvaluateRouteDeps,
  admission: AppIdentityAdmission,
): EvaluateRouteDeps {
  return {
    ...deps,
    assignmentStore: admittedAssignmentStore(deps.assignmentStore, admission),
    exposureAssembly: { ...deps.exposureAssembly, saltStore: admission.saltStore },
  };
}

function evaluateInput(input: unknown): EvaluateInput {
  const root = record(input);
  const body = record(root.body);
  return {
    body: {
      appId: optionalStringField(body, "appId"),
      flagKey: stringField(body, "flagKey"),
      targetingKey: stringField(body, "targetingKey"),
      idType: stringField(body, "idType"),
      attributes: record(body.attributes) as EvaluatePathInput["evaluationContext"]["attributes"],
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evaluation-api: expected parsed object input");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`evaluation-api: missing ${key}`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`evaluation-api: invalid ${key}`);
  }
  return field;
}

class CapturingProvider implements Provider {
  flag: FlagConfig | null = null;

  constructor(private readonly inner: Provider) {}

  async getFlag(appId: string, environmentId: string, flagKey: string) {
    this.flag = await this.inner.getFlag(appId, environmentId, flagKey);
    return this.flag;
  }

  getExperiment(...args: Parameters<Provider["getExperiment"]>) {
    return this.inner.getExperiment(...args);
  }

  getFlags(...args: Parameters<Provider["getFlags"]>) {
    return this.inner.getFlags(...args);
  }
}
