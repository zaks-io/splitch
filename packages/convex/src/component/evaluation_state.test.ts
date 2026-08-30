import { describe, expect, it, vi } from "vitest";
import type { QueryCtx } from "./_generated/server";
import { runtimeState } from "./evaluation_state";

describe("Convex evaluation state", () => {
  it("reads only the Assignment for the Flag's live Experiment", async () => {
    const indexedFields: Array<[string, unknown]> = [];
    const uniqueAssignment = vi.fn().mockResolvedValue({
      experimentId: "experiment_1",
      runId: "run_1",
      variant: "treatment",
    });
    const assignmentQuery = {
      withIndex: vi.fn((_index: string, apply: (query: unknown) => unknown) => {
        const query = {
          eq(field: string, value: unknown) {
            indexedFields.push([field, value]);
            return query;
          },
        };
        apply(query);
        return { unique: uniqueAssignment };
      }),
    };
    const query = vi.fn((table: string) => {
      if (table === "integrations")
        return indexed({
          state: "active",
          appId: "app_1",
          environmentId: "environment_1",
          componentIdentityKey: "identity-key",
          announcedVersion: 7,
        });
      if (table === "snapshots")
        return indexed({ environmentVersion: 7, payload: JSON.stringify(snapshot) });
      if (table === "assignments") return assignmentQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = await runtimeState({ db: { query } } as unknown as QueryCtx, "checkout", {
      targetingKey: "entity_1",
      idType: "user",
      attributes: {},
    });

    expect(uniqueAssignment).toHaveBeenCalledOnce();
    expect(indexedFields.map(([field]) => field)).toEqual([
      "idType",
      "targetingKeyHash",
      "experimentId",
    ]);
    expect(indexedFields.at(-1)).toEqual(["experimentId", "experiment_1"]);
    expect(runtime.assignments).toEqual(
      new Map([["experiment_1", { runId: "run_1", variant: "treatment" }]]),
    );
  });
});

function indexed(value: unknown) {
  return { withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(value) })) };
}

const snapshot = {
  schemaVersion: 1,
  environmentVersion: 7,
  appId: "app_1",
  environmentId: "environment_1",
  flags: [
    {
      id: "flag_1",
      key: "checkout",
      environmentId: "environment_1",
      experimentId: "experiment_1",
      enabled: true,
      defaultVariantId: "control",
      variants: [
        { id: "control", name: "control", value: false },
        { id: "treatment", name: "treatment", value: true },
      ],
      availableVariantNames: ["control", "treatment"],
      targetingRules: [],
      rollout: null,
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  ],
  experiments: [
    {
      id: "experiment_1",
      environmentId: "environment_1",
      flagId: "flag_1",
      targetingKey: "userId",
      targetingKeyType: "user",
      status: "running",
      liveRunId: "run_1",
    },
  ],
  runs: [
    {
      id: "run_1",
      experimentId: "experiment_1",
      salt: "stable-salt",
      allocation: { control: 50, treatment: 50 },
      variantSet: [
        { id: "control", name: "control", value: false },
        { id: "treatment", name: "treatment", value: true },
      ],
      targetingRules: [],
      configHash: "sha256:run-1",
      startedAt: "2026-08-30T00:00:00.000Z",
    },
  ],
};
