import type { ErrorResponse, Variant } from "@splitch/contracts";
import type { EvaluateResult } from "./evaluate/evaluate-path";
import { errorResponse } from "./evaluation-error-response";
import type { FlagConfig } from "./provider/provider";

export function sdkRuntime(request: Request): string {
  const value = request.headers.get("x-splitch-sdk-runtime");
  return value && value.length <= 64 ? value : "unknown";
}

/**
 * The arm label travels beside the body, not in it: the wire body is frozen for
 * already-published strict SDK parsers (see DataPlaneEvaluateResponseSchema).
 */
export function responseBody(
  flag: FlagConfig,
  result: Exclude<EvaluateResult, { kind: "error" }>,
):
  | { ok: true; value: { variant: Variant["value"] | null }; variantName: string | null }
  | { ok: false; error: ErrorResponse } {
  const value = valueForVariant(flag.variants, result);
  return value.ok
    ? { ok: true, value: { variant: value.value }, variantName: result.variant }
    : {
        ok: false,
        error: errorResponse(
          "INTERNAL_SERVER_ERROR",
          `Variant "${value.variantName}" has no value`,
        ),
      };
}

function valueForVariant(
  variants: readonly Variant[],
  result: Exclude<EvaluateResult, { kind: "error" }>,
): { ok: true; value: Variant["value"] | null } | { ok: false; variantName: string | null } {
  if (result.variant === null) return { ok: true, value: null };
  const variant = variants.find((item) => item.name === result.variant);
  return variant === undefined
    ? { ok: false, variantName: result.variant }
    : { ok: true, value: variant.value };
}
