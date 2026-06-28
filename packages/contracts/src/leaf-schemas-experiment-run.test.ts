import { describe, expect, it } from "vitest";
import type { Run } from "./leaf-schemas-experiment.js";
import { RunSchema, RunStatusSchema, runStatuses } from "./leaf-schemas-experiment.js";

const validVariantSet = [
  { id: "var_1", name: "control", value: false },
  { id: "var_2", name: "treatment", value: "on" },
];

const validTargetingRule = {
  id: "tr_1",
  flagId: "flag_1",
  priority: 0,
  conditions: [{ attribute: "plan", operator: "eq" as const, value: "enterprise" }],
  variantId: "var_1",
};

// allocation is keyed by Variant NAME, summing to 100.
const validRun = {
  id: "run_1",
  experimentId: "exp_1",
  environmentId: "env_prod",
  status: "running" as const,
  targetingKeyType: "user",
  salt: "run-salt-abc",
  allocation: { control: 50, treatment: 50 },
  variantSet: validVariantSet,
  targetingRules: [validTargetingRule],
  configHash: "sha256:deadbeef",
  startedAt: "2024-01-01T00:00:00Z",
  createdAt: "2024-01-01T00:00:00Z",
};

describe("RunStatusSchema", () => {
  it("accepts every declared status", () => {
    for (const s of runStatuses) {
      expect(RunStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects 'draft' — pause/draft live on Experiment.status, not Run", () => {
    expect(RunStatusSchema.safeParse("draft").success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(RunStatusSchema.safeParse("paused").success).toBe(false);
  });
});

describe("RunSchema", () => {
  it("parses a full valid run with name-keyed allocation summing to 100", () => {
    const r = RunSchema.parse(validRun);
    expect(r.id).toBe("run_1");
    expect(r.allocation).toEqual({ control: 50, treatment: 50 });
    expect(r.variantSet).toHaveLength(2);
    expect(r.targetingRules).toHaveLength(1);
  });

  it("accepts an empty targetingRules array (all Entities eligible)", () => {
    const r = RunSchema.parse({ ...validRun, targetingRules: [] });
    expect(r.targetingRules).toHaveLength(0);
  });

  it("accepts null endedAt", () => {
    const r = RunSchema.parse({ ...validRun, endedAt: null });
    expect(r.endedAt).toBeNull();
  });

  it("accepts a set endedAt", () => {
    const r = RunSchema.parse({ ...validRun, endedAt: "2024-02-01T00:00:00Z" });
    expect(r.endedAt).toBe("2024-02-01T00:00:00Z");
  });

  it("accepts fractional allocations that sum to 100", () => {
    const r = RunSchema.parse({
      ...validRun,
      allocation: { a: 33.33, b: 33.33, c: 33.34 },
    });
    expect(Object.keys(r.allocation)).toHaveLength(3);
  });

  it("rejects allocation summing to less than 100", () => {
    expect(
      RunSchema.safeParse({ ...validRun, allocation: { control: 40, treatment: 50 } }).success,
    ).toBe(false);
  });

  it("rejects allocation summing to more than 100", () => {
    expect(
      RunSchema.safeParse({ ...validRun, allocation: { control: 60, treatment: 50 } }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range share even when the shares net to 100", () => {
    // {120, -20} sums to 100 but each share is nonsensical traffic; per-share
    // bounds [0,100] must catch this independently of the sum refinement.
    expect(
      RunSchema.safeParse({ ...validRun, allocation: { control: 120, treatment: -20 } }).success,
    ).toBe(false);
  });

  it("rejects a non-numeric allocation value", () => {
    expect(
      RunSchema.safeParse({ ...validRun, allocation: { control: "50", treatment: 50 } }).success,
    ).toBe(false);
  });

  it("rejects missing salt (immutable bucketing input)", () => {
    const { salt: _, ...rest } = validRun;
    expect(RunSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing configHash (integrity anchor)", () => {
    const { configHash: _, ...rest } = validRun;
    expect(RunSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an invalid status", () => {
    expect(RunSchema.safeParse({ ...validRun, status: "draft" }).success).toBe(false);
  });
});

describe("Run leaf carries ONLY canonical leaf fields", () => {
  // Storage-only / decision columns live ONLY on the D1 runs table (S09).
  // The leaf type must not carry them. Asserted at the type level: a Run with
  // any of these keys does not satisfy the schema-inferred shape.
  it("does not include storage-only/decision keys in the inferred type", () => {
    type Key = keyof Run;
    type Forbidden =
      | "run_number"
      | "horizon"
      | "target_n"
      | "sample_size_locked"
      | "decision_family"
      | "guardrail_decisions"
      | "targeting_key_field"
      | "start_reason"
      | "end_reason"
      | "confidence_level";
    // If any forbidden key were part of Run, this Extract would be non-never
    // and the assignment to `never` would fail to compile.
    type Leaked = Extract<Key, Forbidden>;
    const _assertNoLeak: Leaked extends never ? true : never = true;
    expect(_assertNoLeak).toBe(true);
  });

  it("keeps the leaf field set exactly as specified", () => {
    const expected = [
      "id",
      "experimentId",
      "environmentId",
      "status",
      "targetingKeyType",
      "salt",
      "allocation",
      "variantSet",
      "targetingRules",
      "configHash",
      "startedAt",
      "endedAt",
      "createdAt",
    ].sort();
    const r = RunSchema.parse({ ...validRun, endedAt: null });
    expect(Object.keys(r).sort()).toEqual(expected);
  });
});
