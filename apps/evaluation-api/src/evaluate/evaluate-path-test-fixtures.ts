import type { EvaluationContext, TargetingRule, Variant } from "@splitch/contracts";
import type { AssignmentPutInput, AssignmentStore } from "../assignment/assignment-store";
import type { RunConfig } from "../assignment/run-config";
import type { ExperimentConfig, FlagConfig, Provider } from "../provider/provider";
import type { EvaluatePathInput } from "./evaluate-path";

export const APP_ID = "app-A";
export const ENVIRONMENT_ID = "env-1";
export const FLAG_KEY = "checkout-banner";
export const EXPERIMENT_ID = "exp-7";
export const LIVE_RUN_ID = "run-live";

const variants: Variant[] = [
  { id: "v-control", name: "control", value: false },
  { id: "v-treatment", name: "treatment", value: true },
];

const evaluationContext: EvaluationContext = {
  targetingKey: "user-1",
  idType: "user",
  attributes: { plan: "enterprise", score: 7, email: "ops@acme.com" },
};

export function baseInput(overrides: Partial<EvaluatePathInput> = {}): EvaluatePathInput {
  return {
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    flagKey: FLAG_KEY,
    evaluationContext,
    ...overrides,
  };
}

export function flagConfig(overrides: Partial<FlagConfig> = {}): FlagConfig {
  return {
    flagKey: FLAG_KEY,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    experimentId: EXPERIMENT_ID,
    enabled: true,
    defaultVariant: "control",
    variants,
    targetingRules: [],
    ...overrides,
  };
}

export function experimentConfig(overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    experimentId: EXPERIMENT_ID,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    targetingKeyType: "user",
    status: "running",
    liveRunId: overrides.liveRun === null ? null : LIVE_RUN_ID,
    liveRun: runConfig(),
    ...overrides,
  };
}

export function runConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: LIVE_RUN_ID,
    salt: "run-salt",
    allocation: { control: 50, treatment: 50 },
    variantSet: variants,
    targetingRules: [],
    targetingKey: "targetingKey",
    ...overrides,
  };
}

export function targetingRule(overrides: Partial<TargetingRule> = {}): TargetingRule {
  return {
    id: "rule-1",
    flagId: "flag-1",
    priority: 0,
    conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
    variantId: "v-treatment",
    ...overrides,
  };
}

export class RecordingAssignmentStore implements AssignmentStore {
  readonly getAllCalls: Array<Parameters<AssignmentStore["getAll"]>[0]> = [];
  readonly putCalls: AssignmentPutInput[] = [];
  private readonly calls?: string[];
  private readonly holdovers: Map<string, { runId: string; variant: string }>;

  constructor(
    options: {
      calls?: string[];
      holdovers?: Map<string, { runId: string; variant: string }>;
    } = {},
  ) {
    this.calls = options.calls;
    this.holdovers = options.holdovers ?? new Map();
  }

  async getAll(input: Parameters<AssignmentStore["getAll"]>[0]) {
    this.calls?.push("getAll");
    this.getAllCalls.push(input);
    return this.holdovers;
  }

  async put(input: AssignmentPutInput) {
    this.putCalls.push(input);
    return {
      status: "stored" as const,
      assignment: { runId: input.runId, variant: input.variant },
    };
  }
}

export class RecordingProvider implements Provider {
  readonly flagCalls: string[] = [];
  readonly experimentCalls: string[] = [];
  private readonly calls?: string[];
  private readonly flag: FlagConfig;
  private readonly experiment: ExperimentConfig;
  private readonly getFlagError?: Error;
  private readonly getExperimentError?: Error;

  constructor(
    options: {
      calls?: string[];
      experiment?: ExperimentConfig;
      flag?: FlagConfig;
      getExperimentError?: Error;
      getFlagError?: Error;
    } = {},
  ) {
    this.calls = options.calls;
    this.flag = options.flag ?? flagConfig();
    this.experiment = options.experiment ?? experimentConfig();
    this.getFlagError = options.getFlagError;
    this.getExperimentError = options.getExperimentError;
  }

  async getFlag(_appId: string, _environmentId: string, flagKey: string) {
    this.calls?.push("getFlag");
    this.flagCalls.push(flagKey);
    if (this.getFlagError !== undefined) {
      throw this.getFlagError;
    }
    return this.flag;
  }

  async getExperiment(_appId: string, _environmentId: string, experimentId: string) {
    this.calls?.push("getExperiment");
    this.experimentCalls.push(experimentId);
    if (this.getExperimentError !== undefined) {
      throw this.getExperimentError;
    }
    return this.experiment;
  }

  async getFlags() {
    return [this.flag];
  }
}

export class RecordingLogger implements Pick<Console, "error" | "warn"> {
  readonly errors: unknown[] = [];
  readonly warnings: unknown[] = [];

  error(message?: unknown, ...optionalParams: unknown[]) {
    this.errors.push([message, ...optionalParams]);
  }

  warn(message?: unknown, ...optionalParams: unknown[]) {
    this.warnings.push([message, ...optionalParams]);
  }
}
