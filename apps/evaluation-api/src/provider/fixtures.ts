import type { ExperimentConfigKV, FlagConfigKV, RunConfigKV } from "@splitch/contracts";

/**
 * Valid fixture KV blobs conforming to the S06 storage schemas. Tests seed these
 * (or partial overrides) into the FakeKv; the negative tests mutate a copy to make
 * it malformed. NEVER produced by the platform write path — hand-built fixtures.
 */

export function flagConfigKV(overrides: Partial<FlagConfigKV> = {}): FlagConfigKV {
  return {
    id: "flag-id-1",
    key: "checkout-banner",
    environmentId: "env-1",
    experimentId: "exp-7",
    enabled: true,
    defaultVariantId: "v-control",
    variants: [
      { id: "v-control", name: "control", value: false },
      { id: "v-treatment", name: "treatment", value: true },
    ],
    availableVariantNames: ["control", "treatment"],
    targetingRules: [],
    rollout: null,
    updatedAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

export function experimentConfigKV(
  overrides: Partial<ExperimentConfigKV> = {},
): ExperimentConfigKV {
  return {
    id: "exp-7",
    environmentId: "env-1",
    flagId: "flag-id-1",
    targetingKey: "userId",
    targetingKeyType: "user",
    status: "running",
    liveRunId: "run-42",
    ...overrides,
  };
}

export function runConfigKV(overrides: Partial<RunConfigKV> = {}): RunConfigKV {
  return {
    id: "run-42",
    experimentId: "exp-7",
    salt: "run-salt-xyz",
    allocation: { control: 50, treatment: 50 },
    variantSet: [
      { id: "v-control", name: "control", value: false },
      { id: "v-treatment", name: "treatment", value: true },
    ],
    targetingRules: [],
    configHash: "deadbeef",
    startedAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}
