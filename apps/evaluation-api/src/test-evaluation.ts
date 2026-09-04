import {
  type ErrorCode,
  type ErrorResponse,
  TestEvaluationResponseSchema,
  type Variant,
} from "@splitch/contracts";
import { resolutionReasonFor } from "@splitch/evaluation-core";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import {
  admittedEvaluatePathDeps,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "./app-identity-traffic";
import { evaluatePath } from "./evaluate/evaluate-path";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path-types";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import { testEvaluationRouteInput } from "./evaluation-route-input";
import { CapturingProvider } from "./provider/capturing-provider";

export function makeTestEvaluationHandler(
  deps: EvaluatePathDeps & { exposureAssembly: ExposureAssemblyDeps },
) {
  return async ({ input, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = testEvaluationRouteInput(input);
    const admitted = await tryAdmitAppIdentity(
      deps.exposureAssembly.saltStore,
      parsed.params.appId,
    );
    if (!admitted.ok) return renderError(admitted.error, { requestId });
    const provider = new CapturingProvider(deps.provider);
    const result = await evaluatePath(
      {
        appId: parsed.params.appId,
        environmentId: parsed.params.environmentId,
        flagKey: parsed.params.flagKey,
        evaluationContext: parsed.body.evaluationContext,
      },
      admittedEvaluatePathDeps({ ...deps, provider }, admitted.admission),
    );

    const stale = await appIdentityAdmissionValidationError(admitted.admission);
    if (stale !== null) return renderError(stale, { requestId });

    if (result.kind === "error") {
      return renderError(
        errorResponse(result.errorCode, result.errorMessage, parsed.params.flagKey),
        { requestId },
      );
    }
    if (provider.flag === null) {
      return renderError(errorResponse("INTERNAL_SERVER_ERROR", "flag config was not resolved"), {
        requestId,
      });
    }

    const value = valueForVariant(provider.flag.variants, result.variant);
    if (!value.ok) {
      return renderError(
        errorResponse("INTERNAL_SERVER_ERROR", `Variant "${result.variant}" has no value`),
        { requestId },
      );
    }

    return Response.json(
      TestEvaluationResponseSchema.parse({
        variantName: result.variant,
        value: value.value,
        resolutionReason: resolutionReasonFor(result.kind),
        reason: result.reason,
        liveRunId: result.liveRunId,
      }),
    );
  };
}

function valueForVariant(
  variants: readonly Variant[],
  variantName: string,
): { ok: true; value: Variant["value"] } | { ok: false } {
  const variant = variants.find((item) => item.name === variantName);
  return variant === undefined ? { ok: false } : { ok: true, value: variant.value };
}

function errorResponse(code: ErrorCode, message: string, flagKey?: string): ErrorResponse {
  if (code === "FLAG_NOT_FOUND") {
    // A Flag id here is the near-miss worth naming: this route resolves by key,
    // and "flag not found" alone sends the caller looking for a missing Flag
    // rather than at the identifier they passed.
    return {
      code,
      message: flagKey?.startsWith("flag_")
        ? `no Flag with key "${flagKey}"; this route takes a Flag key, and "${flagKey}" is a Flag id`
        : "flag not found",
      details: {},
    };
  }
  if (code === "VALIDATION_ERROR") {
    return { code, message, details: { issues: [] } };
  }
  if (code === "INTERNAL_SERVER_ERROR") {
    return { code, message: "evaluation failed", details: {} };
  }
  return { code, message, details: {} } as ErrorResponse;
}
