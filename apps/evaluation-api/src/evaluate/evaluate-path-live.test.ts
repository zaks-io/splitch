import { describe, expect, it } from "vitest";
import { evaluatePath } from "./evaluate-path.js";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  LIVE_RUN_ID,
  RecordingAssignmentStore,
  RecordingProvider,
  baseInput,
  experimentConfig,
  runConfig,
  targetingRule,
} from "./evaluate-path-test-fixtures.js";

describe("evaluatePath live Run paths", () => {
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
        { attribute: "missing", operator: "eq", value: "anything" },
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
