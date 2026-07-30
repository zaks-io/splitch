/**
 * The Review a caller is committing. It deliberately carries NO `appId`: every
 * App predicate in the Approval write paths binds the MINTED `TenantScope` the
 * repository method was called with, which is what the caller was actually
 * authorized for (ADR-0018). A commit-carried `appId` would be caller-supplied
 * data sitting in a tenant predicate, correct only as a global program property
 * rather than a local seam invariant. The field is absent so the compiler
 * refuses to let anyone reintroduce that.
 */
export interface ApprovalCommit {
  requestId: string;
  reviewId: string;
  action: "approve_and_apply";
  reviewedBy: string;
  reviewedVia: string;
  reviewedAt: string;
  reason: string | null;
  idempotencyKey: string;
  requestHash: string;
  resultingTargetVersion: string;
  resultingResourceType: "flag" | "flag_configuration" | "flag_variant" | "experiment_run";
  resultingResourceId: string;
  policyContexts: ApprovalPolicyContextGuard[];
}

export interface ApprovalPolicyContextGuard {
  environmentId: string;
  changeTypes: Array<
    "variant_availability" | "targeting_rollout_value" | "enabled_state" | "start_experiment_run"
  >;
  level: "allow" | "confirm" | "approve";
}

/** Same rule as `ApprovalCommit`: the App comes from the minted scope only. */
export interface ApprovalDisposition {
  requestId: string;
  reviewId: string;
  action: "approve_and_apply" | "decline";
  outcome: "declined" | "stale";
  reviewedBy: string;
  reviewedVia: string;
  reviewedAt: string;
  reason: string | null;
  idempotencyKey: string;
  requestHash: string;
}

/** Same rule as `ApprovalCommit`: the App comes from the minted scope only. */
export interface ApprovalFailure {
  requestId: string;
  reviewId: string;
  reviewedBy: string;
  reviewedVia: string;
  reviewedAt: string;
  reason: string | null;
  idempotencyKey: string;
  requestHash: string;
  errorCode: string;
  errorDetails: string;
}
