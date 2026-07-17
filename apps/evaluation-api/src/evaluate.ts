import {
  DataPlaneEvaluateResponseSchema,
  type DataPlaneEvaluateRequest,
  type ErrorCode,
  type ErrorResponse,
  type Variant,
} from "@splitch/contracts";
import { renderError, type HandlerArgs, type Principal } from "@splitch/worker-runtime";
import { evaluate } from "./evaluate/accessor-paths";
import type { AssembledExposure, ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types";
import type { EvaluateResult } from "./evaluate/evaluate-path";
import type { ExposureSink } from "./exposure-sink";
import { ExposureSinkError } from "./exposure-sink";
import type { EvaluationUsageSink } from "./evaluation-usage-sink";
import { writeEvaluationUsage, type EvaluationUsageScope } from "./evaluation-usage";
import type { FlagConfig, Provider } from "./provider/provider";

type EvaluateInput = {
  body: DataPlaneEvaluateRequest;
};

interface EvaluateRouteDeps extends EvaluatePathDeps {
  readonly exposureAssembly: ExposureAssemblyDeps;
  readonly exposureSink: ExposureSink;
  readonly evaluationUsageSink: EvaluationUsageSink;
  /**
   * `ctx.waitUntil` seam for the fire-and-forget Assignment Store write
   * (holdover-write-contract.md). When absent (unit harnesses), the write still
   * fires but nothing keeps the runtime alive for it.
   */
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

    const evaluated = await evaluateWithCapture(parsed.body, scope.value, deps);
    return evaluateResponse(evaluated, deps, requestId, request);
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

  const write = await writeExposures(output.exposures, deps);
  if (!write.ok) return renderError(write.error, { requestId });

  const usageWrite = await writeEvaluationUsage(
    output.exposures.length > 0,
    request.headers.get("idempotency-key") ?? requestId,
    evaluated.scope,
    deps,
    () => errorResponse("SERVICE_UNAVAILABLE", "Evaluation usage ingest is unavailable"),
  );
  if (!usageWrite.ok) return renderError(usageWrite.error, { requestId });

  // Only record the holdover AFTER the Exposure is accepted by ingest. If the
  // holdover were written first and ingest then 503s, the SDK re-fires and hits
  // the holdover-replay path (which fires NO Exposure) — so that entity's
  // Exposure would never be persisted for this Run. Writing the holdover last
  // means a 503 leaves no holdover, the re-fire re-assigns deterministically
  // (same Variant, sticky experience preserved), and re-attempts the Exposure.
  scheduleHoldoverWrite(output.result, deps);

  return Response.json(DataPlaneEvaluateResponseSchema.parse(body.value));
}

function responseBody(
  flag: FlagConfig,
  result: Exclude<EvaluateResult, { kind: "error" }>,
): { ok: true; value: { variant: Variant["value"] | null } } | { ok: false; error: ErrorResponse } {
  const value = valueForVariant(flag.variants, result);
  return value.ok
    ? { ok: true, value: { variant: value.value } }
    : {
        ok: false,
        error: errorResponse(
          "INTERNAL_SERVER_ERROR",
          `Variant "${value.variantName}" has no value`,
        ),
      };
}

/**
 * The holdover write (holdover-write-contract.md): every result that fires an
 * Exposure records its first-touch `(run_id, variant)` in the Assignment Store
 * so a Run boundary replays the sticky Variant instead of re-assigning
 * (ADR-0006). Fire-and-forget in `ctx.waitUntil` — the SDK caller never waits;
 * a failed write self-heals on the next evaluate (the writer re-asserts KV).
 * Holdover replays carry `exposure: null`, so they never re-write.
 */
function scheduleHoldoverWrite(result: EvaluateResult, deps: EvaluateRouteDeps): void {
  const exposure = result.kind === "error" ? null : result.exposure;
  if (exposure === null) return;

  const write = deps.assignmentStore
    .put({
      appId: exposure.appId,
      idType: exposure.idType,
      targetingKey: exposure.targetingKey,
      experimentId: exposure.experimentId,
      runId: exposure.liveRunId,
      variant: exposure.variant,
    })
    .then(
      () => undefined,
      (cause) => {
        // Non-blocking per the failure contract: a missed holdover write is a
        // cosmetic cross-POP miss (assign() is deterministic), retried on the
        // next evaluate. Loud in logs so operators see repeated failures.
        deps.logger?.error("assignment_store_put_failed", { cause });
      },
    );
  deps.waitUntil?.(write);
}

async function writeExposures(
  exposures: readonly AssembledExposure[],
  deps: EvaluateRouteDeps,
): Promise<{ ok: true } | { ok: false; error: ErrorResponse }> {
  try {
    for (const exposure of exposures) {
      await deps.exposureSink.write(exposure);
    }
    return { ok: true };
  } catch (cause) {
    if (!(cause instanceof ExposureSinkError)) {
      throw cause;
    }
    deps.logger?.error("exposure_sink_failed", { cause });
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "Exposure ingest is unavailable"),
    };
  }
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

function valueForVariant(
  variants: readonly Variant[],
  result: Exclude<EvaluateResult, { kind: "error" }>,
): { ok: true; value: Variant["value"] | null } | { ok: false; variantName: string | null } {
  if (result.variant === null) {
    return { ok: true, value: null };
  }
  const variant = variants.find((item) => item.name === result.variant);
  return variant === undefined
    ? { ok: false, variantName: result.variant }
    : { ok: true, value: variant.value };
}

function errorResponse(code: ErrorCode, message: string): ErrorResponse {
  if (code === "FLAG_NOT_FOUND") {
    return { code, message: "flag not found", details: {} };
  }
  if (code === "VALIDATION_ERROR") {
    return { code, message, details: { issues: [] } };
  }
  if (code === "INTERNAL_SERVER_ERROR") {
    return { code, message: "evaluation failed", details: {} };
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return { code, message, details: { retryAfterMs: 1000 } };
  }
  return { code, message, details: {} } as ErrorResponse;
}
