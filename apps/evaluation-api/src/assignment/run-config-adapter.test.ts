import type { ExperimentConfigKV, RunConfigKV } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { assign } from "./assign";
import { runConfigFromKV } from "./run-config-adapter";

const runKV: RunConfigKV = {
  id: "run-42",
  experimentId: "exp-7",
  salt: "run-salt-xyz",
  allocation: { control: 50, treatment: 50 },
  variantSet: [
    { id: "v-c", name: "control", value: false },
    { id: "v-t", name: "treatment", value: true },
  ],
  targetingRules: [],
  configHash: "deadbeef",
  startedAt: "2026-06-28T00:00:00.000Z",
};

const experimentKV: ExperimentConfigKV = {
  id: "exp-7",
  environmentId: "env-1",
  flagId: "flag-9",
  targetingKey: "userId",
  targetingKeyType: "user",
  status: "running",
  liveRunId: "run-42",
};

describe("runConfigFromKV", () => {
  it("assembles a clean RunConfig from the two KV blobs", () => {
    const config = runConfigFromKV(runKV, experimentKV);
    expect(config).toEqual({
      runId: "run-42",
      salt: "run-salt-xyz",
      allocation: { control: 50, treatment: 50 },
      variantSet: runKV.variantSet,
      targetingRules: [],
      targetingKey: "userId",
    });
  });

  it("folds targetingKey in from the Experiment blob (absent from the Run blob)", () => {
    const config = runConfigFromKV(runKV, { ...experimentKV, targetingKey: "workspaceId" });
    expect(config.targetingKey).toBe("workspaceId");
  });

  it("feeds assign() the same result as the matching hand-built golden vector", () => {
    const config = runConfigFromKV(runKV, experimentKV);
    // Matches the assign.test.ts golden vectors for salt "run-salt-xyz".
    expect(assign(config, "user-50")).toBe("control");
    expect(assign(config, "user-0")).toBe("treatment");
  });
});
