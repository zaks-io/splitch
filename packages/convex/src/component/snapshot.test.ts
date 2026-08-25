import { describe, expect, it } from "vitest";
import { parseSnapshot, snapshotProvider } from "./snapshot";

const snapshot = {
  schemaVersion: 1 as const,
  environmentVersion: 7,
  appId: "app_1",
  environmentId: "env_1",
  flags: [
    {
      id: "flag_1",
      key: "checkout",
      environmentId: "env_1",
      experimentId: "exp_1",
      enabled: true,
      defaultVariantId: "control",
      variants: [
        { id: "control", name: "control", value: false },
        { id: "treatment", name: "treatment", value: true },
      ],
      availableVariantNames: ["control", "treatment"],
      targetingRules: [],
      rollout: null,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  ],
  experiments: [
    {
      id: "exp_1",
      environmentId: "env_1",
      flagId: "flag_1",
      targetingKey: "userId",
      targetingKeyType: "user",
      status: "running" as const,
      liveRunId: "run_1",
    },
  ],
  runs: [
    {
      id: "run_1",
      experimentId: "exp_1",
      salt: "stable-salt",
      allocation: { control: 50, treatment: 50 },
      variantSet: [
        { id: "control", name: "control", value: false },
        { id: "treatment", name: "treatment", value: true },
      ],
      targetingRules: [],
      configHash: "sha256:run-1",
      startedAt: "2026-08-25T00:00:00.000Z",
    },
  ],
};

describe("Convex snapshot", () => {
  it("builds the shared evaluator Provider from a strict snapshot", async () => {
    const parsed = parseSnapshot(JSON.stringify(snapshot));
    const provider = snapshotProvider(parsed);

    await expect(provider.getFlag("app_1", "env_1", "checkout")).resolves.toMatchObject({
      defaultVariant: "control",
      experimentId: "exp_1",
    });
    await expect(provider.getExperiment("app_1", "env_1", "exp_1")).resolves.toMatchObject({
      liveRun: { runId: "run_1", configHash: "sha256:run-1" },
    });
  });

  it("rejects cross-scope and dangling references without replacing good state", () => {
    expect(() =>
      parseSnapshot(
        JSON.stringify({
          ...snapshot,
          flags: [{ ...snapshot.flags[0], environmentId: "env_other" }],
        }),
      ),
    ).toThrow(/crosses Environment scope/);
    expect(() => parseSnapshot(JSON.stringify({ ...snapshot, runs: [] }))).toThrow(
      /absent live Run/,
    );
  });
});
