import {
  type DataPlaneEvaluateRequest,
  type ErrorResponse,
  PeekEvaluateResponseSchema,
  type Variant,
} from "@splitch/contracts";
import { type HandlerArgs, type Principal, renderError } from "@splitch/worker-runtime";
import {
  admittedEvaluatePathDeps,
  appIdentityAdmissionValidationError,
  tryAdmitAppIdentity,
} from "./app-identity-traffic";
import { peekVariant } from "./evaluate/accessor-paths";
import type { EvaluateResult } from "./evaluate/evaluate-path";
import type { EvaluatePathDeps } from "./evaluate/evaluate-path-types";
import type { ExposureAssemblyDeps } from "./evaluate/exposure-assembly";
import { errorResponse } from "./evaluation-error-response";
import { evaluationRouteInput } from "./evaluation-route-input";
import { CapturingProvider } from "./provider/capturing-provider";

type ResolvedEvaluateResult = Exclude<EvaluateResult, { kind: "error" }>;
type PeekDefaultFallbackKind = Extract<
  ResolvedEvaluateResult["kind"],
  "disabled" | "no_live_run" | "null_experiment" | "no_match_default"
>;

interface CredentialScope {
  readonly appId: string;
  readonly environmentId: string;
}

export function makePeekHandler(
  deps: EvaluatePathDeps & { exposureAssembly: ExposureAssemblyDeps },
) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = evaluationRouteInput(input);
    const scope = credentialScope(principal, parsed.body.appId);
    if (!scope.ok) return renderError(scope.error, { requestId });
    const admitted = await tryAdmitAppIdentity(deps.exposureAssembly.saltStore, scope.value.appId);
    if (!admitted.ok) return renderError(admitted.error, { requestId });

    const evaluated = await peekWithCapture(
      parsed.body,
      scope.value,
      admittedEvaluatePathDeps(deps, admitted.admission),
    );
    const stale = await appIdentityAdmissionValidationError(admitted.admission);
    if (stale !== null) return renderError(stale, { requestId });
    return peekResponse(evaluated, requestId);
  };
}

function credentialScope(
  principal: Principal,
  appId: string | undefined,
): { ok: true; value: CredentialScope } | { ok: false; error: ErrorResponse } {
  if (principal.appId === null || principal.environmentId === null) {
    return {
      ok: false,
      error: errorResponse("INTERNAL_SERVER_ERROR", "credential is not environment-scoped", {
        disclosure: "trusted",
      }),
    };
  }
  const assertionError = appAssertionError(appId, principal.appId);
  return assertionError === null
    ? { ok: true, value: { appId: principal.appId, environmentId: principal.environmentId } }
    : { ok: false, error: assertionError };
}

async function peekWithCapture(
  body: DataPlaneEvaluateRequest,
  scope: CredentialScope,
  deps: EvaluatePathDeps,
) {
  const provider = new CapturingProvider(deps.provider);
  const output = await peekVariant(
    {
      appId: scope.appId,
      environmentId: scope.environmentId,
      flagKey: body.flagKey,
      evaluationContext: {
        targetingKey: body.targetingKey,
        idType: body.idType,
        attributes: body.attributes,
      },
    },
    { ...deps, provider },
  );
  return { output, provider };
}

function peekResponse(
  evaluated: Awaited<ReturnType<typeof peekWithCapture>>,
  requestId: string,
): Response {
  const { output, provider } = evaluated;
  const resolved = resolvePeekResult(output.result);
  if (!resolved.ok) {
    return renderError(resolved.error, { requestId });
  }
  if (provider.flag === null) {
    return renderError(
      errorResponse("INTERNAL_SERVER_ERROR", "flag config was not resolved", {
        disclosure: "trusted",
      }),
      { requestId },
    );
  }

  const value = valueForVariant(provider.flag.variants, resolved.result);
  if (!value.ok) {
    return renderError(
      errorResponse("INTERNAL_SERVER_ERROR", `Variant "${value.variantName}" has no value`, {
        disclosure: "trusted",
      }),
      { requestId },
    );
  }

  return Response.json(PeekEvaluateResponseSchema.parse({ variant: value.value }));
}

function resolvePeekResult(
  result: EvaluateResult,
): { ok: true; result: ResolvedEvaluateResult } | { ok: false; error: ErrorResponse } {
  if (result.kind === "error") {
    return {
      ok: false,
      error: errorResponse(result.errorCode, result.errorMessage, { disclosure: "trusted" }),
    };
  }
  if (isPeekDefaultFallback(result)) {
    return {
      ok: false,
      error: errorResponse(
        "VALIDATION_ERROR",
        `peek cannot return a Default Variant fallback (${result.kind})`,
        { disclosure: "trusted" },
      ),
    };
  }
  return { ok: true, result };
}

function appAssertionError(appId: string | undefined, scopedAppId: string): ErrorResponse | null {
  return appId !== undefined && appId !== scopedAppId
    ? errorResponse("APP_MISMATCH", "credential does not belong to appId", {
        disclosure: "trusted",
      })
    : null;
}

function isPeekDefaultFallback(
  result: ResolvedEvaluateResult,
): result is Extract<ResolvedEvaluateResult, { kind: PeekDefaultFallbackKind }> {
  return (
    result.kind === "disabled" ||
    result.kind === "no_live_run" ||
    result.kind === "null_experiment" ||
    result.kind === "no_match_default"
  );
}

function valueForVariant(
  variants: readonly Variant[],
  result: Exclude<EvaluateResult, { kind: "error" }>,
): { ok: true; value: Variant["value"] } | { ok: false; variantName: string | null } {
  if (result.variant === null) {
    return { ok: false, variantName: null };
  }
  const variant = variants.find((item) => item.name === result.variant);
  return variant === undefined
    ? { ok: false, variantName: result.variant }
    : { ok: true, value: variant.value };
}
