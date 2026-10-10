import { type Experiment, ExperimentSchema } from "../leaf-schemas-experiment";

const defaults = {
  id: "exp_1",
  appId: "app_1",
  environmentId: "env_1",
  key: "checkout-copy",
  flagId: "flag_1",
  name: "Checkout copy",
  status: "draft",
  targetingKey: "userId",
  targetingKeyType: "user",
  confidenceLevel: 0.95,
  defaultVariantId: "var_1",
  metrics: [],
  guardrailMetrics: [],
  conversionWindowMs: 0,
  dimensions: [],
  liveRunId: null,
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
} satisfies Experiment;

export function experimentResourceFixture(overrides: Partial<Experiment> = {}): Experiment {
  return ExperimentSchema.parse({ ...defaults, ...overrides });
}
