// biome-ignore lint/performance/noBarrelFile: Runtime-neutral evaluator consumers need one explicit package entry point.
export { assign, fractionalEval, type Rollout } from "./assignment";
export { type ConditionMatchOptions, matchesConditions } from "./conditions";
export {
  AssignmentStoreError,
  ConditionMatchError,
  EvaluatePathError,
  ProviderError,
} from "./errors";
export { evaluatePath } from "./evaluate";
export { hashToUnitInterval } from "./hash";
export type {
  AssignmentStoreEntry,
  AssignmentStoreReader,
  BaselineRolloutEvaluateResult,
  ErrorEvaluateResult,
  EvaluatePathDeps,
  EvaluatePathInput,
  EvaluateResult,
  ExperimentConfig,
  ExposureDecision,
  FlagConfig,
  FreshAssignmentEvaluateResult,
  HoldoverEvaluateResult,
  NoMatchEvaluateResult,
  NonExposingEvaluateResult,
  Provider,
  RuleMatchEvaluateResult,
  RunConfig,
} from "./types";
