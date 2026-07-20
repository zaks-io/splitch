import { describe, expect, it } from "vitest";
import { evaluatePath } from "./evaluate-path";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  LIVE_RUN_ID,
  RecordingAssignmentStore,
  RecordingLogger,
  RecordingProvider,
  baseInput,
  experimentConfig,
  runConfig,
  targetingRule,
} from "./evaluate-path-test-fixtures";

describe("evaluatePath idType validation", () => {
  it("idType mismatch fails loud before fresh assignment or Exposure", async () => {
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      experiment: experimentConfig({
        targetingKeyType: "workspace",
        liveRun: runConfig({
          allocation: { control: 0, treatment: 100 },
          targetingRules: [],
        }),
      }),
    });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "error",
      variant: "control",
      reason: "ERROR",
      errorCode: "VALIDATION_ERROR",
      liveRunId: null,
      exposure: null,
    });
    expect(store.getAllCalls).toEqual([]);
    expect(store.putCalls).toEqual([]);
  });
});

describe("evaluatePath condition validation", () => {
  it.each([
    ["missing", {}],
    ["null", { plan: null as never }],
  ] as const)(
    "%s Targeting Rule attribute fails loud with no Exposure decision",
    async (_caseName, attributes) => {
      const rule = targetingRule({
        id: "rule-null-attribute",
        conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
      });
      const store = new RecordingAssignmentStore();
      const provider = new RecordingProvider({
        experiment: experimentConfig({ liveRun: runConfig({ targetingRules: [rule] }) }),
      });
      const logger = new RecordingLogger();

      const result = await evaluatePath(
        baseInput({
          evaluationContext: { targetingKey: "user-1", idType: "user", attributes },
        }),
        { assignmentStore: store, provider, logger },
      );

      expect(result).toMatchObject({
        kind: "error",
        variant: "control",
        reason: "ERROR",
        errorCode: "VALIDATION_ERROR",
        liveRunId: null,
        exposure: null,
      });
      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]).toMatchObject([
        "condition_attribute_null",
        { attribute: "plan", operator: "eq", ruleId: "rule-null-attribute" },
      ]);
      expect(logger.errors).toHaveLength(1);
      expect(store.putCalls).toEqual([]);
    },
  );
});

describe("evaluatePath live Run paths", () => {
  it("an empty Targeting Rule snapshot treats all Entities as eligible and uses Assignment", async () => {
    const provider = new RecordingProvider({
      experiment: experimentConfig({
        liveRun: runConfig({
          salt: "run-salt-xyz",
          allocation: { control: 50, treatment: 50 },
          targetingRules: [],
        }),
      }),
    });

    const result = await evaluatePath(
      baseInput({
        evaluationContext: {
          targetingKey: "user-0",
          idType: "user",
          attributes: { plan: "enterprise" },
        },
      }),
      { assignmentStore: new RecordingAssignmentStore(), provider },
    );

    expect(result).toMatchObject({
      kind: "fresh_assignment",
      variant: "treatment",
      reason: { type: "fresh_assignment" },
      experimentId: EXPERIMENT_ID,
      liveRunId: LIVE_RUN_ID,
      exposure: { variant: "treatment", liveRunId: LIVE_RUN_ID, targetingKey: "user-0" },
    });
  });

  it("a direct Targeting Rule match returns the rule Variant and an Exposure decision", async () => {
    const rule = targetingRule({ id: "rule-direct", variantId: "v-treatment" });
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      experiment: experimentConfig({ liveRun: runConfig({ targetingRules: [rule] }) }),
    });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "rule_match_direct",
      variant: "treatment",
      experimentId: EXPERIMENT_ID,
      liveRunId: LIVE_RUN_ID,
      reason: {
        type: "rule_matched",
        ruleId: "rule-direct",
        ruleName: null,
        priority: 0,
        selection: "direct",
        rollout: null,
      },
      exposure: {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        flagKey: FLAG_KEY,
        idType: "user",
        liveRunId: LIVE_RUN_ID,
        targetingKey: "user-1",
        variant: "treatment",
      },
    });
  });

  it("a percentage Targeting Rule match runs Fractional Evaluation and returns a distinct result", async () => {
    const rule = targetingRule({
      id: "rule-percentage",
      variantId: "v-treatment",
      percentageRollout: { percentage: 0, salt: "rule-rollout" },
    });
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      experiment: experimentConfig({ liveRun: runConfig({ targetingRules: [rule] }) }),
    });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "rule_match_percentage",
      variant: "control",
      reason: {
        type: "rule_matched",
        ruleId: "rule-percentage",
        ruleName: null,
        priority: 0,
        selection: "percentage_rollout",
        rollout: { variantWeights: [{ variantName: "treatment", weight: 0 }] },
      },
      exposure: { variant: "control", liveRunId: LIVE_RUN_ID },
    });
  });

  it("no Targeting Rule match returns Default Variant with a live Exposure decision", async () => {
    const rule = targetingRule({
      id: "rule-miss",
      conditions: [{ attribute: "plan", operator: "eq", value: "free" }],
    });
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      experiment: experimentConfig({ liveRun: runConfig({ targetingRules: [rule] }) }),
    });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "no_match_default",
      variant: "control",
      reason: { type: "no_match_default" },
      experimentId: EXPERIMENT_ID,
      liveRunId: LIVE_RUN_ID,
      exposure: { variant: "control", liveRunId: LIVE_RUN_ID },
    });
  });

  it("iterates Targeting Rules in priority order and applies AND semantics", async () => {
    const lateMatchingRule = targetingRule({
      id: "late",
      priority: 10,
      variantId: "v-treatment",
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
    });
    const earlyMissingAttributeRule = targetingRule({
      id: "early",
      priority: 1,
      variantId: "v-control",
      conditions: [
        { attribute: "plan", operator: "eq", value: "enterprise" },
        { attribute: "score", operator: "gt", value: 99 },
      ],
    });
    const provider = new RecordingProvider({
      experiment: experimentConfig({
        liveRun: runConfig({ targetingRules: [lateMatchingRule, earlyMissingAttributeRule] }),
      }),
    });

    const result = await evaluatePath(baseInput(), {
      assignmentStore: new RecordingAssignmentStore(),
      provider,
    });

    expect(result.kind).toBe("rule_match_direct");
    expect(result.variant).toBe("treatment");
  });
});
