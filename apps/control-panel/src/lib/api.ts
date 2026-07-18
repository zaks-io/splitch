import type { ErrorResponse } from "@splitch/contracts";

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly status: number }
  | { readonly ok: false; readonly error: ErrorResponse; readonly status: number };

type FormFieldError = {
  readonly field: string;
  readonly code: string;
  readonly message: string;
};

export type MutationErrorSurface =
  | {
      readonly kind: "field";
      readonly message: string;
      readonly fields: readonly FormFieldError[];
    }
  | {
      readonly kind: "tier";
      readonly message: string;
      readonly fields: readonly [];
    }
  | {
      readonly kind: "form";
      readonly message: string;
      readonly fields: readonly [];
    };

/** Turns the control-plane's authoritative error response into form state. */
export function mutationErrorSurface(
  result: Extract<ApiResult<never>, { ok: false }>,
): MutationErrorSurface {
  if (result.status === 403) {
    return { kind: "tier", message: result.error.message, fields: [] };
  }

  if (result.status === 400 && result.error.code === "VALIDATION_ERROR") {
    return {
      kind: "field",
      message: result.error.message,
      fields: result.error.details.issues.map((issue) => ({
        field: issue.path.join("."),
        code: result.error.code,
        message: issue.message,
      })),
    };
  }

  return { kind: "form", message: result.error.message, fields: [] };
}
