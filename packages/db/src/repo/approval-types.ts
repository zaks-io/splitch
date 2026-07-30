export interface ApprovalCommit {
  requestId: string;
  appId: string;
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

export interface ApprovalDisposition {
  requestId: string;
  appId: string;
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

export interface ApprovalFailure {
  requestId: string;
  appId: string;
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
