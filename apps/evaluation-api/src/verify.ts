import {
  type ErrorCode,
  type ErrorResponse,
  ResolutionDetailsSchema,
  type ResolutionReason,
  type Variant,
} from "@splitch/contracts";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { verify } from "./evaluate/accessor-paths.js";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types.js";
import type { EvaluateResult } from "./evaluate/evaluate-path.js";
import type { FlagConfig, Provider } from "./provider/provider.js";

type VerifyInput = {
  body: {
    flagKey: string;
    targetingKey: string;
    idType: string;
    attributes: EvaluatePathInput["evaluationContext"]["attributes"];
  };
};

export function makeVerifyHandler(deps: EvaluatePathDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = verifyInput(input);
    if (principal.appId === null || principal.environmentId === null) {
      return renderError(
        errorResponse("INTERNAL_SERVER_ERROR", "credential is not environment-scoped"),
        {
          requestId,
        },
      );
    }

    const provider = new CapturingProvider(deps.provider);
    const output = await verify(
      {
        appId: principal.appId,
        environmentId: principal.environmentId,
        flagKey: parsed.body.flagKey,
        evaluationContext: {
          targetingKey: parsed.body.targetingKey,
          idType: parsed.body.idType,
          attributes: parsed.body.attributes,
        },
      },
      { ...deps, provider },
    );

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

    const details = verifyDetails(output.result, provider.flag, principal.kind === "api-key");
    if (!details.ok) {
      return renderError(
        errorResponse("INTERNAL_SERVER_ERROR", `Variant "${details.variantName}" has no value`),
        { requestId },
      );
    }

    return Response.json(ResolutionDetailsSchema.parse(details.value));
  };
}

function verifyInput(input: unknown): VerifyInput {
  const root = record(input);
  const body = record(root.body);
  const attributes = body.attributes;
  return {
    body: {
      flagKey: stringField(body, "flagKey"),
      targetingKey: stringField(body, "targetingKey"),
      idType: stringField(body, "idType"),
      attributes: record(attributes) as VerifyInput["body"]["attributes"],
    },
  };
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
