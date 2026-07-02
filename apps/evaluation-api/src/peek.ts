import {
  type ErrorCode,
  type ErrorResponse,
  PeekEvaluateResponseSchema,
  type Variant,
} from "@splitch/contracts";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { peekVariant } from "./evaluate/accessor-paths.js";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types.js";
import type { EvaluateResult } from "./evaluate/evaluate-path.js";
import type { FlagConfig, Provider } from "./provider/provider.js";

type PeekInput = {
  body: {
    flagKey: string;
    targetingKey: string;
    idType: string;
    attributes: EvaluatePathInput["evaluationContext"]["attributes"];
  };
};

export function makePeekHandler(deps: EvaluatePathDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = peekInput(input);
    if (principal.appId === null || principal.environmentId === null) {
      return renderError(
        errorResponse("INTERNAL_SERVER_ERROR", "credential is not environment-scoped"),
        {
          requestId,
        },
      );
    }

    const provider = new CapturingProvider(deps.provider);
    const output = await peekVariant(
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

    const value = valueForVariant(provider.flag.variants, output.result);
    if (!value.ok) {
      return renderError(
        errorResponse("INTERNAL_SERVER_ERROR", `Variant "${value.variantName}" has no value`),
        { requestId },
      );
    }

    return Response.json(PeekEvaluateResponseSchema.parse({ variant: value.value }));
  };
}

function peekInput(input: unknown): PeekInput {
  const root = record(input);
  const body = record(root.body);
  const attributes = body.attributes;
  return {
    body: {
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
