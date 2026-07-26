import { describe, expect, it } from "vitest";
import { evaluatePath } from "./evaluate-path";
import {
  RecordingAssignmentStore,
  RecordingProvider,
  baseInput,
  experimentConfig,
  flagConfig,
  targetingRule,
} from "./evaluate-path-test-fixtures";

const SALT = "baseline-salt-01";

function evaluate(flag: ReturnType<typeof flagConfig>, targetingKey = "user-1") {
  return evaluatePath(baseInput({ evaluationContext: context(targetingKey) }), {
    assignmentStore: new RecordingAssignmentStore(),
    provider: new RecordingProvider({ flag, experiment: experimentConfig({ liveRun: null }) }),
  });
}

function context(targetingKey: string) {
  return { targetingKey, idType: "user" as const, attributes: { plan: "enterprise" } };
}

describe("baseline rollout precedence", () => {
  it("(a) no baseline and no rule falls through to the Default Variant", async () => {
    const result = await evaluate(flagConfig({ experimentId: null, rollout: null }));

    expect(result).toMatchObject({
      kind: "no_match_default",
      variant: "control",
      reason: { type: "no_match_default" },
      exposure: null,
    });
  });

  it("(b) a baseline decides unmatched traffic and says so in its own reason", async () => {
    // `baseline_rollout` must never collapse into `no_match_default`: outside the
    // band both serve "control", and only the reason distinguishes them.
    const result = await evaluate(
      flagConfig({ experimentId: null, rollout: { percentage: 100, salt: SALT } }),
    );

    expect(result).toMatchObject({
      kind: "baseline_rollout",
      variant: "treatment",
      reason: {
        type: "baseline_rollout",
        rollout: {
          variantWeights: [
            { variantName: "treatment", weight: 100 },
            { variantName: "control", weight: 0 },
          ],
        },
      },
      liveRunId: null,
      exposure: null,
    });
  });

  it("(c) a MATCHED Targeting Rule wins outright and the baseline never runs", async () => {
    const result = await evaluate(
      flagConfig({
        experimentId: null,
        // 0% would serve "control" for every key, so a "treatment" here can only
        // have come from the rule.
        rollout: { percentage: 0, salt: SALT },
        targetingRules: [targetingRule()],
      }),
    );

    expect(result).toMatchObject({
      kind: "rule_match_direct",
      variant: "treatment",
      reason: { type: "rule_matched", ruleId: "rule-1" },
    });
  });

  it("(d) an UNMATCHED Targeting Rule falls through to the baseline, not the Default", async () => {
    const result = await evaluate(
      flagConfig({
        experimentId: null,
        rollout: { percentage: 100, salt: SALT },
        targetingRules: [
          targetingRule({
            conditions: [{ attribute: "plan", operator: "eq", value: "free" }],
          }),
        ],
      }),
    );

    expect(result).toMatchObject({ kind: "baseline_rollout", variant: "treatment" });
  });

  it("a live Run's allocation is authoritative — the baseline does NOT reshape it", async () => {
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      flag: flagConfig({ rollout: { percentage: 100, salt: SALT } }),
    });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "fresh_assignment",
      reason: { type: "fresh_assignment" },
    });
  });

  it("a disabled flag ignores the baseline entirely", async () => {
    const result = await evaluate(
      flagConfig({ enabled: false, rollout: { percentage: 100, salt: SALT } }),
    );

    expect(result).toMatchObject({ kind: "disabled", variant: "control" });
  });
});

describe("baseline rollout boundaries", () => {
  const keys = ["user-1", "user-2", "user-3", "user-4", "user-5", "user-6", "user-7", "user-8"];

  it("0% serves the Default Variant to every key", async () => {
    const flag = flagConfig({ experimentId: null, rollout: { percentage: 0, salt: SALT } });

    for (const key of keys) {
      expect(await evaluate(flag, key)).toMatchObject({
        kind: "baseline_rollout",
        variant: "control",
      });
    }
  });

  it("100% serves the rolled-into Variant to every key", async () => {
    const flag = flagConfig({ experimentId: null, rollout: { percentage: 100, salt: SALT } });

    for (const key of keys) {
      expect(await evaluate(flag, key)).toMatchObject({
        kind: "baseline_rollout",
        variant: "treatment",
      });
    }
  });
});

describe("baseline rollout bucketing stability", () => {
  // 500 keys is enough that a reshuffled bucket layout is a near-certain failure
  // rather than a coin flip.
  const keys = Array.from({ length: 500 }, (_, index) => `user-${index}`);

  async function variantsAt(percentage: number, salt = SALT) {
    const flag = flagConfig({ experimentId: null, rollout: { percentage, salt } });
    const results = new Map<string, string>();
    for (const key of keys) {
      const result = await evaluate(flag, key);
      results.set(key, (result as { variant: string }).variant);
    }
    return results;
  }

  it("only ever ADDS keys as the percentage widens — nobody is ever dropped", async () => {
    // The property that makes a percentage change safe: the same salt keeps the
    // bucket layout fixed, so raising the percentage widens the band monotonically
    // instead of reshuffling who is inside it.
    const at10 = await variantsAt(10);
    const at50 = await variantsAt(50);

    const inside10 = keys.filter((key) => at10.get(key) === "treatment");
    const inside50 = keys.filter((key) => at50.get(key) === "treatment");

    expect(inside10.length).toBeGreaterThan(0);
    expect(inside50.length).toBeGreaterThan(inside10.length);
    for (const key of inside10) {
      expect(at50.get(key)).toBe("treatment");
    }
  });

  it("shrinking the percentage only REMOVES keys, never swaps them", async () => {
    const at50 = await variantsAt(50);
    const at10 = await variantsAt(10);

    for (const key of keys) {
      if (at10.get(key) === "treatment") expect(at50.get(key)).toBe("treatment");
    }
  });

  it("a DIFFERENT salt reshuffles the cohort — which is why the salt is never reminted", async () => {
    // The negative control for the whole design: if this did not diverge, the
    // salt would not be carrying bucket identity and the invariant would be vacuous.
    const original = await variantsAt(50);
    const reshuffled = await variantsAt(50, "a-different-salt");

    const moved = keys.filter((key) => original.get(key) !== reshuffled.get(key));
    expect(moved.length).toBeGreaterThan(keys.length / 10);
  });
});

describe("baseline rollout fails loud on an ambiguous Variant set", () => {
  it.each([
    ["more than one non-Default available Variant", ["control", "treatment", "variant-c"]],
    ["no non-Default available Variant at all", ["control"]],
  ])("throws when there is %s", async (_label, availableVariantNames) => {
    // Guessing which Variant to roll INTO would silently send traffic somewhere
    // nobody asked for, so this degrades to the error result (ADR-0036).
    const result = await evaluate(
      flagConfig({
        experimentId: null,
        availableVariantNames,
        rollout: { percentage: 50, salt: SALT },
      }),
    );

    expect(result).toMatchObject({ kind: "error", variant: "control" });
  });
});
