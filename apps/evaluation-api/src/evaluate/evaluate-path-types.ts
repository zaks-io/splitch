import type { ErrorCode, EvaluationContext, TestEvaluationReason } from "@splitch/contracts";
import type { AssignmentStore } from "../assignment/assignment-store";
import type { Provider } from "../provider/provider";

type EvaluateKind =
  | "disabled"
  | "null_experiment"
  | "holdover_replay"
  | "no_live_run"
  | "fresh_assignment"
  | "rule_match_direct"
  | "rule_match_percentage"
  | "baseline_rollout"
  | "no_match_default"
  | "error";

type VariantName = string;

export interface EvaluatePathInput {
  appId: string;
  environmentId: string;
  flagKey: string;
  evaluationContext: EvaluationContext;
}

export interface EvaluatePathDeps {
  assignmentStore: AssignmentStore;
  provider: Provider;
  logger?: Pick<Console, "error" | "warn">;
}

export interface ExposureDecision {
  appId: string;
  environmentId: string;
  experimentId: string;
  flagKey: string;
  idType: string;
  liveRunId: string;
  targetingKey: string;
  variant: VariantName;
}

interface BaseEvaluateResult {
  kind: EvaluateKind;
  variant: VariantName | null;
  reason: TestEvaluationReason | "ERROR" | "STALE";
  exposure: ExposureDecision | null;
}

export interface NonExposingEvaluateResult extends BaseEvaluateResult {
  kind: "disabled" | "null_experiment" | "no_live_run";
  exposure: null;
  liveRunId: null;
  reason: { type: "default_disabled" };
  variant: VariantName;
}

interface HoldoverEvaluateResult extends BaseEvaluateResult {
  kind: "holdover_replay";
  exposure: null;
  isHoldover: true;
  liveRunId: null;
  priorRunId: string;
  reason: { type: "holdover_replay"; priorRunId: string };
  variant: VariantName;
}

export interface RuleMatchEvaluateResult extends BaseEvaluateResult {
  kind: "rule_match_direct" | "rule_match_percentage";
  exposure: ExposureDecision | null;
  experimentId?: string;
  liveRunId: string | null;
  reason: Extract<TestEvaluationReason, { type: "rule_matched" }>;
  variant: VariantName;
}

export interface FreshAssignmentEvaluateResult extends BaseEvaluateResult {
  kind: "fresh_assignment";
  exposure: ExposureDecision;
  experimentId: string;
  liveRunId: string;
  reason: Extract<TestEvaluationReason, { type: "fresh_assignment" }>;
  variant: VariantName;
}

/**
 * The config-level baseline rollout decided this: no Targeting Rule matched and
 * the Flag Configuration carries a `rollout`. Distinct from `no_match_default`
 * so the two are never conflated — they return the same Variant whenever the key
 * falls outside the band, and only the reason tells them apart.
 */
export interface BaselineRolloutEvaluateResult extends BaseEvaluateResult {
  kind: "baseline_rollout";
  exposure: null;
  experimentId?: string;
  liveRunId: null;
  reason: Extract<TestEvaluationReason, { type: "baseline_rollout" }>;
  variant: VariantName;
}

export interface NoMatchEvaluateResult extends BaseEvaluateResult {
  kind: "no_match_default";
  exposure: ExposureDecision | null;
  experimentId?: string;
  liveRunId: string | null;
  reason: { type: "no_match_default" };
  variant: VariantName;
}

export interface ErrorEvaluateResult extends BaseEvaluateResult {
  kind: "error";
  errorCode: ErrorCode;
  errorMessage: string;
  exposure: null;
  liveRunId: null;
  reason: "ERROR" | "STALE";
}

export type EvaluateResult =
  | NonExposingEvaluateResult
  | HoldoverEvaluateResult
  | FreshAssignmentEvaluateResult
  | RuleMatchEvaluateResult
  | BaselineRolloutEvaluateResult
  | NoMatchEvaluateResult
  | ErrorEvaluateResult;
