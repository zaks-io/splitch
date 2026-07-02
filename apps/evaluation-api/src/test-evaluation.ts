import {
  type ErrorCode,
  type ErrorResponse,
  TestEvaluationResponseSchema,
  type Variant,
} from "@splitch/contracts";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { evaluatePath } from "./evaluate/evaluate-path.js";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types.js";
import type { FlagConfig, Provider } from "./provider/provider.js";

type TestEvaluationInput = {
  params: { appId: string; environmentId: string; flagId: string };
  body: { evaluationContext: EvaluatePathInput["evaluationContext"] };
};

export function makeTestEvaluationHandler(deps: EvaluatePathDeps) {
  return async ({ input, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const parsed = testEvaluationInput(input);
    const provider = new CapturingProvider(deps.provider);
    const result = await evaluatePath(
      {
        appId: parsed.params.appId,
        environmentId: parsed.params.environmentId,
        flagKey: parsed.params.flagId,
        evaluationContext: parsed.body.evaluationContext,
      },
      { ...deps, provider },
    );

    if (result.kind === "error") {
      return renderError(errorResponse(result.errorCode, result.errorMessage), { requestId });
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
        reason: result.reason,
        liveRunId: result.liveRunId,
      }),
    );
  };
}

function testEvaluationInput(input: unknown): TestEvaluationInput {
  const root = record(input);
  const params = record(root.params);
  const body = record(root.body);
  const evaluationContext = body.evaluationContext;
  if (typeof evaluationContext !== "object" || evaluationContext === null) {
    throw new Error("evaluation-api: missing evaluationContext");
  }
  return {
    params: {
      appId: stringField(params, "appId"),
      environmentId: stringField(params, "environmentId"),
      flagId: stringField(params, "flagId"),
    },
    body: {
      evaluationContext: evaluationContext as TestEvaluationInput["body"]["evaluationContext"],
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
