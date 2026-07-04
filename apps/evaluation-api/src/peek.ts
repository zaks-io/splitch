import {
  type ErrorCode,
  type ErrorResponse,
  PeekEvaluateResponseSchema,
  type Variant,
} from "@splitch/contracts";
import { renderError, type HandlerArgs, type Principal } from "@splitch/worker-runtime";
import { peekVariant } from "./evaluate/accessor-paths.js";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types.js";
import type { EvaluateResult } from "./evaluate/evaluate-path.js";
import type { FlagConfig, Provider } from "./provider/provider.js";

type ResolvedEvaluateResult = Exclude<EvaluateResult, { kind: "error" }>;
type PeekDefaultFallbackKind = Extract<
  ResolvedEvaluateResult["kind"],
  "disabled" | "no_live_run" | "null_experiment" | "no_match_default"
>;

type PeekInput = {
  body: {
    appId?: string;
    flagKey: string;
    targetingKey: string;
    idType: string;
    attributes: EvaluatePathInput["evaluationContext"]["attributes"];
  };
};

interface CredentialScope {
  readonly appId: string;
  readonly environmentId: string;
}

export function makePeekHandler(deps: EvaluatePathDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = peekInput(input);
    const scope = credentialScope(principal, parsed.body.appId);
    if (!scope.ok) return renderError(scope.error, { requestId });

    const evaluated = await peekWithCapture(parsed.body, scope.value, deps);
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
      error: errorResponse("INTERNAL_SERVER_ERROR", "credential is not environment-scoped"),
    };
  }
  const assertionError = appAssertionError(appId, principal.appId);
  return assertionError === null
    ? { ok: true, value: { appId: principal.appId, environmentId: principal.environmentId } }
    : { ok: false, error: assertionError };
}

async function peekWithCapture(
  body: PeekInput["body"],
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
    return renderError(errorResponse("INTERNAL_SERVER_ERROR", "flag config was not resolved"), {
      requestId,
    });
  }

  const value = valueForVariant(provider.flag.variants, resolved.result);
  if (!value.ok) {
    return renderError(
      errorResponse("INTERNAL_SERVER_ERROR", `Variant "${value.variantName}" has no value`),
      { requestId },
    );
  }

  return Response.json(PeekEvaluateResponseSchema.parse({ variant: value.value }));
}

function resolvePeekResult(
  result: EvaluateResult,
): { ok: true; result: ResolvedEvaluateResult } | { ok: false; error: ErrorResponse } {
  if (result.kind === "error") {
    return { ok: false, error: errorResponse(result.errorCode, result.errorMessage) };
  }
  if (isPeekDefaultFallback(result)) {
    return {
      ok: false,
      error: errorResponse(
        "VALIDATION_ERROR",
        `peek cannot return a Default Variant fallback (${result.kind})`,
      ),
    };
  }
  return { ok: true, result };
}

function appAssertionError(appId: string | undefined, scopedAppId: string): ErrorResponse | null {
  return appId !== undefined && appId !== scopedAppId
    ? errorResponse("APP_MISMATCH", "credential does not belong to appId")
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

function peekInput(input: unknown): PeekInput {
  const root = record(input);
  const body = record(root.body);
  const attributes = body.attributes;
  return {
    body: {
      appId: optionalStringField(body, "appId"),
      flagKey: stringField(body, "flagKey"),
      targetingKey: stringField(body, "targetingKey"),
      idType: stringField(body, "idType"),
      attributes: record(attributes) as PeekInput["body"]["attributes"],
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
): { ok: true; value: Variant["value"] } | { ok: false; variantName: string | null } {
  if (result.variant === null) {
    return { ok: false, variantName: null };
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
  return { code, message, details: {} } as ErrorResponse;
}
