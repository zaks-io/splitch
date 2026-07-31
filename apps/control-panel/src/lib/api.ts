import type { ErrorCode, ErrorResponse } from "@splitch/contracts";

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly status: number }
  | { readonly ok: false; readonly error: ErrorResponse; readonly status: number };

type FormFieldError = {
  readonly field: string;
  readonly code: string;
  readonly message: string;
};

type ApprovalReviewRequired = Extract<ErrorResponse, { code: "APPROVAL_REVIEW_REQUIRED" }>;

/**
 * The call never reached a structured refusal — the request itself failed.
 *
 * It is a panel-local code, deliberately not one of the Worker's: reusing a real
 * ErrorCode here would report a decision the Control Plane never made.
 */
type SurfaceErrorCode = ErrorCode | "TRANSPORT_FAILURE";

/** The immutable Policy context the Worker attached to a gated refusal. */
type ApprovalPolicyContext = ApprovalReviewRequired["details"]["policyContexts"][number];

/**
 * Every surface carries `code`. A surface that kept only `message` forced callers
 * to pattern-match prose to tell one refusal from another, and prose is not a
 * contract.
 */
export type MutationErrorSurface =
  | {
      readonly kind: "field";
      readonly code: SurfaceErrorCode;
      readonly message: string;
      readonly fields: readonly FormFieldError[];
    }
  | {
      readonly kind: "tier";
      readonly code: SurfaceErrorCode;
      readonly message: string;
      readonly fields: readonly [];
    }
  /**
   * The Worker refused a Policy-gated write and durably recorded the proposal.
   * The request id is the whole point of the refusal — flattening it into a
   * generic message strands the operator with an unactionable error while a real
   * pending Approval Request sits in the audit log.
   */
  | {
      readonly kind: "approval";
      readonly code: "APPROVAL_REVIEW_REQUIRED";
      readonly message: string;
      readonly approvalRequestId: string;
      readonly policyContexts: readonly ApprovalPolicyContext[];
      readonly fields: readonly [];
    }
  /**
   * The Approval Request is already closed. WHICH way it closed decides the
   * operator's next move — re-proposing after an `applied` Review would be a
   * second copy of a change that already landed — so the disposition travels
   * with the refusal instead of being flattened into prose.
   */
  | {
      readonly kind: "resolved";
      readonly code: "APPROVAL_REQUEST_RESOLVED";
      readonly message: string;
      readonly status: "applied" | "declined" | "stale";
      readonly fields: readonly [];
    }
  | {
      readonly kind: "form";
      readonly code: SurfaceErrorCode;
      readonly message: string;
      readonly fields: readonly [];
    };

/**
 * A live Run owns these fields. The Worker names them and names the Run; a
 * message alone would leave the operator guessing which edit to back out and
 * which Run to end, so each frozen field is pinned to the input it came from.
 */
function frozenSurface(
  error: Extract<ErrorResponse, { code: "RUN_FROZEN" }>,
): MutationErrorSurface {
  return {
    kind: "field",
    code: error.code,
    message: error.message,
    fields: error.details.frozenFields.map((frozen) => ({
      field: frozen.replace(/^flagConfig\./, ""),
      code: error.code,
      message: `${frozen} is frozen while ${error.details.currentRunId} is running`,
    })),
  };
}

/** Turns the control-plane's authoritative error response into form state. */
export function mutationErrorSurface(
  result: Extract<ApiResult<never>, { ok: false }>,
): MutationErrorSurface {
  const { error } = result;

  if (error.code === "APPROVAL_REVIEW_REQUIRED") {
    return {
      kind: "approval",
      code: error.code,
      message: error.message,
      approvalRequestId: error.details.approvalRequestId,
      policyContexts: error.details.policyContexts,
      fields: [],
    };
  }

  /**
   * The Worker names the Variants it cannot serve here. Dropping them leaves the
   * operator with "requested variants are not available" and no way to tell WHICH
   * one — a refusal nobody can act on is the disguised default ADR-0036 forbids.
   */
  if (error.code === "VARIANT_NOT_AVAILABLE") {
    return {
      kind: "field",
      code: error.code,
      message: error.message,
      fields: error.details.missingVariants.map((variant) => ({
        field: "availableVariantNames",
        code: error.code,
        message: `${variant} is not available in this Environment`,
      })),
    };
  }

  if (error.code === "RUN_FROZEN") {
    return frozenSurface(error);
  }

  if (error.code === "APPROVAL_REQUEST_RESOLVED") {
    return {
      kind: "resolved",
      code: error.code,
      message: error.message,
      status: error.details.status,
      fields: [],
    };
  }

  if (result.status === 403) {
    return { kind: "tier", code: error.code, message: error.message, fields: [] };
  }

  if (result.status === 400 && error.code === "VALIDATION_ERROR") {
    return {
      kind: "field",
      code: error.code,
      message: error.message,
      fields: error.details.issues.map((issue) => ({
        field: issue.path.join("."),
        code: error.code,
        message: issue.message,
      })),
    };
  }

  return { kind: "form", code: error.code, message: error.message, fields: [] };
}
