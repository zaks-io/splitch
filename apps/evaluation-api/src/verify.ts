import {
  type ErrorCode,
  type ErrorResponse,
  ResolutionDetailsSchema,
  type ResolutionReason,
  type Variant,
} from "@splitch/contracts";
import { renderError, type HandlerArgs, type Principal } from "@splitch/worker-runtime";
import { verify } from "./evaluate/accessor-paths";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types";
import type { EvaluateResult } from "./evaluate/evaluate-path";
import type { FlagConfig, Provider } from "./provider/provider";

type VerifyInput = {
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

export function makeVerifyHandler(deps: EvaluatePathDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = verifyInput(input);
    const scope = credentialScope(principal, parsed.body.appId);
    if (!scope.ok) return renderError(scope.error, { requestId });

    const evaluated = await verifyWithCapture(parsed.body, scope.value, deps);
    return verifyResponse(evaluated, principal.kind === "api-key", requestId);
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

async function verifyWithCapture(
  body: VerifyInput["body"],
  scope: CredentialScope,
  deps: EvaluatePathDeps,
) {
  const provider = new CapturingProvider(deps.provider);
  const output = await verify(
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

function verifyResponse(
  evaluated: Awaited<ReturnType<typeof verifyWithCapture>>,
  trusted: boolean,
  requestId: string,
): Response {
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

  const details = verifyDetails(output.result, provider.flag, trusted);
  if (!details.ok) {
    return renderError(
      errorResponse("INTERNAL_SERVER_ERROR", `Variant "${details.variantName}" has no value`),
      { requestId },
    );
  }

  return Response.json(ResolutionDetailsSchema.parse(details.value));
}

function verifyInput(input: unknown): VerifyInput {
  const root = record(input);
  const body = record(root.body);
  const attributes = body.attributes;
  return {
    body: {
      appId: optionalStringField(body, "appId"),
      flagKey: stringField(body, "flagKey"),
      targetingKey: stringField(body, "targetingKey"),
      idType: stringField(body, "idType"),
      attributes: record(attributes) as VerifyInput["body"]["attributes"],
    },
  };
}

function appAssertionError(appId: string | undefined, scopedAppId: string): ErrorResponse | null {
  return appId !== undefined && appId !== scopedAppId
    ? errorResponse("APP_MISMATCH", "credential does not belong to appId")
    : null;
}

function verifyDetails(
  result: Exclude<EvaluateResult, { kind: "error" }>,
  flag: FlagConfig,
  trusted: boolean,
):
  | { ok: true; value: ReturnType<typeof ResolutionDetailsSchema.parse> }
  | { ok: false; variantName: string | null } {
  if (result.variant === null) {
    return { ok: false, variantName: null };
  }
  const value = valueForVariant(flag.variants, result.variant);
  if (!value.ok) {
    return { ok: false, variantName: result.variant };
  }

  const details: Record<string, unknown> = {
    value: value.value,
    variantName: result.variant,
    reason: reasonFor(result, trusted),
  };

  if (trusted && (result.kind === "rule_match_direct" || result.kind === "rule_match_percentage")) {
    details.ruleId = result.reason.ruleId;
  }

  return { ok: true, value: ResolutionDetailsSchema.parse(details) };
}

function reasonFor(
  result: Exclude<EvaluateResult, { kind: "error" }>,
  trusted: boolean,
): ResolutionReason {
  if (result.kind === "disabled") return "DISABLED";
  if (result.kind === "no_match_default" || result.kind === "null_experiment") return "DEFAULT";
  if (result.kind === "rule_match_direct" || result.kind === "rule_match_percentage") {
    return trusted ? "TARGETING_MATCH" : "SPLIT";
  }
  return "SPLIT";
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
  variantName: string,
): { ok: true; value: Variant["value"] } | { ok: false } {
  const variant = variants.find((item) => item.name === variantName);
  return variant === undefined ? { ok: false } : { ok: true, value: variant.value };
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
