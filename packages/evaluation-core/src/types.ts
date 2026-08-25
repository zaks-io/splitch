import type {
  ErrorCode,
  EvaluationContext,
  ExperimentStatus,
  PercentageRollout,
  ResolvedTargetingRule,
  TestEvaluationReason,
  Variant,
} from "@splitch/contracts";

export type RunConfig = {
  runId: string;
  salt: string;
  allocation: Record<string, number>;
  variantSet: Variant[];
  targetingRules: ResolvedTargetingRule[];
  targetingKey: string;
  configHash?: string;
};

export interface FlagConfig {
  flagKey: string;
  appId: string;
  environmentId: string;
  experimentId: string | null;
  enabled: boolean;
  defaultVariant: string;
  variants: Variant[];
  availableVariantNames: string[];
  targetingRules: ResolvedTargetingRule[];
  rollout: PercentageRollout | null;
}

export interface ExperimentConfig {
  experimentId: string;
  appId: string;
  environmentId: string;
  targetingKeyType: string;
  status: ExperimentStatus;
  liveRunId: string | null;
  liveRun: RunConfig | null;
}

export interface Provider {
  getExperiment(
    appId: string,
    environmentId: string,
    experimentId: string,
  ): Promise<ExperimentConfig>;
  getFlag(appId: string, environmentId: string, flagKey: string): Promise<FlagConfig>;
  getFlags(appId: string, environmentId: string): Promise<FlagConfig[]>;
}

export interface AssignmentStoreEntry {
  runId: string;
  variant: string;
}

export interface AssignmentStoreReader {
  getAll(input: {
    appId: string;
    idType: string;
    targetingKey: string;
  }): Promise<Map<string, AssignmentStoreEntry>>;
  put(input: {
    appId: string;
    experimentId: string;
    idType: string;
    targetingKey: string;
    runId: string;
    variant: string;
  }): Promise<{ status: "stored" | "existing"; assignment: AssignmentStoreEntry }>;
  putHashed(input: {
    appId: string;
    experimentId: string;
    idType: string;
    targetingKeyHash: string;
    runId: string;
    variant: string;
  }): Promise<{ status: "stored" | "existing"; assignment: AssignmentStoreEntry }>;
}

export interface EvaluatePathInput {
  appId: string;
  environmentId: string;
  flagKey: string;
  evaluationContext: EvaluationContext;
}

export interface EvaluatePathDeps {
  assignmentStore: AssignmentStoreReader;
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
  variant: string;
}

interface BaseEvaluateResult {
  kind: string;
  variant: string | null;
  reason: TestEvaluationReason | "ERROR" | "STALE";
  exposure: ExposureDecision | null;
}

export interface NonExposingEvaluateResult extends BaseEvaluateResult {
  kind: "disabled" | "null_experiment" | "no_live_run";
  exposure: null;
  liveRunId: null;
  reason: { type: "default_disabled" };
  variant: string;
}

export interface HoldoverEvaluateResult extends BaseEvaluateResult {
  kind: "holdover_replay";
  exposure: null;
  isHoldover: true;
  liveRunId: null;
  priorRunId: string;
  reason: { type: "holdover_replay"; priorRunId: string };
  variant: string;
}

export interface RuleMatchEvaluateResult extends BaseEvaluateResult {
  kind: "rule_match_direct" | "rule_match_percentage";
  exposure: ExposureDecision | null;
  experimentId?: string;
  liveRunId: string | null;
  reason: Extract<TestEvaluationReason, { type: "rule_matched" }>;
  variant: string;
}

export interface FreshAssignmentEvaluateResult extends BaseEvaluateResult {
  kind: "fresh_assignment";
  exposure: ExposureDecision;
  experimentId: string;
  liveRunId: string;
  reason: Extract<TestEvaluationReason, { type: "fresh_assignment" }>;
  variant: string;
}

export interface BaselineRolloutEvaluateResult extends BaseEvaluateResult {
  kind: "baseline_rollout";
  exposure: null;
  experimentId?: string;
  liveRunId: null;
  reason: Extract<TestEvaluationReason, { type: "baseline_rollout" }>;
  variant: string;
}

export interface NoMatchEvaluateResult extends BaseEvaluateResult {
  kind: "no_match_default";
  exposure: ExposureDecision | null;
  experimentId?: string;
  liveRunId: string | null;
  reason: { type: "no_match_default" };
  variant: string;
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
