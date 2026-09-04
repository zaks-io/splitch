import { describe, expect, it } from "vitest";
import {
  DataPlaneEvaluateRequestSchema,
  DataPlaneEvaluateResponseSchema,
  PeekEvaluateResponseSchema,
  TestEvaluationReasonSchema,
  TestEvaluationRequestSchema,
  TestEvaluationResponseSchema,
} from "./wire-envelopes-core";

describe("DataPlaneEvaluateRequestSchema", () => {
  it("parses a full request", () => {
    const req = DataPlaneEvaluateRequestSchema.parse({
      appId: "app_123",
      flagKey: "feature-x",
      targetingKey: "user-1",
      idType: "user",
      attributes: { plan: "enterprise" },
    });
    expect(req.appId).toBe("app_123");
    expect(req.flagKey).toBe("feature-x");
    expect(req.attributes.plan).toBe("enterprise");
  });

  it("defaults attributes to {} when omitted", () => {
    const req = DataPlaneEvaluateRequestSchema.parse({
      flagKey: "feature-x",
      targetingKey: "user-1",
      idType: "user",
    });
    expect(req.attributes).toEqual({});
  });

  it("fails loud on a __proto__ attribute key instead of silently dropping it", () => {
    const input = JSON.parse(
      '{"flagKey":"feature-x","targetingKey":"user-1","idType":"user","attributes":{"__proto__":true,"plan":"pro"}}',
    ) as unknown;
    const parsed = DataPlaneEvaluateRequestSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues.some((issue) => issue.path.includes("__proto__"))).toBe(true);
  });

  it("rejects a missing flagKey", () => {
    expect(
      DataPlaneEvaluateRequestSchema.safeParse({ targetingKey: "u", idType: "user" }).success,
    ).toBe(false);
  });

  it.each(["appId", "flagKey", "targetingKey", "idType"] as const)(
    "rejects an empty %s",
    (field) => {
      const request = {
        appId: "app_123",
        flagKey: "feature-x",
        targetingKey: "user-1",
        idType: "user",
        attributes: {},
        [field]: "",
      };

      expect(DataPlaneEvaluateRequestSchema.safeParse(request).success).toBe(false);
    },
  );

  it("rejects a nested object attribute value", () => {
    expect(
      DataPlaneEvaluateRequestSchema.safeParse({
        flagKey: "f",
        targetingKey: "u",
        idType: "user",
        attributes: { nested: { deep: true } },
      }).success,
    ).toBe(false);
  });
});

describe("DataPlaneEvaluateResponseSchema (non-revealing, strict)", () => {
  it("parses the bare { variant } shape", () => {
    expect(DataPlaneEvaluateResponseSchema.parse({ variant: "on" }).variant).toBe("on");
  });

  it("accepts a null variant (flag not found or disabled, no default)", () => {
    expect(DataPlaneEvaluateResponseSchema.parse({ variant: null }).variant).toBeNull();
  });

  it("parses an object variant value", () => {
    const res = DataPlaneEvaluateResponseSchema.parse({ variant: { color: "blue" } });
    expect((res.variant as Record<string, unknown>).color).toBe("blue");
  });

  /**
   * The body is frozen because published SDKs inline this schema and parse
   * strictly: @splitch/sdk@0.2.0 swallows the resulting throw and serves the
   * caller's default, after the Worker already committed the Exposure. Adding a
   * key here silently corrupts every running Experiment, so arm labels and Run
   * ids ride response headers instead.
   */
  it("REJECTS every added field, including the arm label that rides x-variant-name", () => {
    for (const extra of [{ variantName: "treatment" }, { reason: "SPLIT" }, { salt: "abc" }]) {
      expect(DataPlaneEvaluateResponseSchema.safeParse({ variant: "on", ...extra }).success).toBe(
        false,
      );
    }
  });
});

describe("PeekEvaluateResponseSchema (API-Key-only, strict)", () => {
  it("reuses the bare { variant } response shape", () => {
    expect(PeekEvaluateResponseSchema.parse({ variant: "on" })).toEqual({ variant: "on" });
  });

  it("rejects leaked reason metadata", () => {
    expect(PeekEvaluateResponseSchema.safeParse({ variant: "on", reason: "SPLIT" }).success).toBe(
      false,
    );
  });

  it("rejects null because peek fails loud instead of falling back", () => {
    expect(PeekEvaluateResponseSchema.safeParse({ variant: null }).success).toBe(false);
  });
});

describe("TestEvaluationRequestSchema", () => {
  it("parses a request carrying the EvaluationContext leaf", () => {
    const req = TestEvaluationRequestSchema.parse({
      evaluationContext: { targetingKey: "u", idType: "user", attributes: {} },
    });
    expect(req.evaluationContext.targetingKey).toBe("u");
  });

  it("rejects a request missing evaluationContext", () => {
    expect(TestEvaluationRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("TestEvaluationReasonSchema (discriminated union narrows on type)", () => {
  it("narrows holdover_replay on the discriminant", () => {
    const r = TestEvaluationReasonSchema.parse({
      type: "holdover_replay",
      priorRunId: "run_0",
    });
    if (r.type === "holdover_replay") {
      expect(r.priorRunId).toBe("run_0");
    } else {
      throw new Error("discriminant did not narrow to holdover_replay");
    }
  });

  it("narrows rule_matched with a percentage rollout", () => {
    const r = TestEvaluationReasonSchema.parse({
      type: "rule_matched",
      ruleId: "tr_1",
      ruleName: "enterprise",
      priority: 0,
      selection: "percentage_rollout",
      rollout: { variantWeights: [{ variantName: "treatment", weight: 50 }] },
    });
    if (r.type === "rule_matched") {
      expect(r.selection).toBe("percentage_rollout");
      expect(r.rollout?.variantWeights[0]?.weight).toBe(50);
    } else {
      throw new Error("discriminant did not narrow to rule_matched");
    }
  });

  it("accepts rule_matched with null ruleName and null rollout (present-with-null)", () => {
    const r = TestEvaluationReasonSchema.parse({
      type: "rule_matched",
      ruleId: "tr_1",
      ruleName: null,
      priority: 1,
      selection: "direct",
      rollout: null,
    });
    if (r.type === "rule_matched") {
      expect(r.ruleName).toBeNull();
      expect(r.rollout).toBeNull();
    } else {
      throw new Error("discriminant did not narrow to rule_matched");
    }
  });

  it("parses fresh_assignment, default_disabled, and no_match_default", () => {
    expect(TestEvaluationReasonSchema.parse({ type: "fresh_assignment" }).type).toBe(
      "fresh_assignment",
    );
    expect(TestEvaluationReasonSchema.parse({ type: "default_disabled" }).type).toBe(
      "default_disabled",
    );
    expect(TestEvaluationReasonSchema.parse({ type: "no_match_default" }).type).toBe(
      "no_match_default",
    );
  });

  it("rejects an unknown discriminant", () => {
    expect(TestEvaluationReasonSchema.safeParse({ type: "fallthrough" }).success).toBe(false);
  });

  it("rejects rule_matched with an omitted rollout (present-with-null)", () => {
    expect(
      TestEvaluationReasonSchema.safeParse({
        type: "rule_matched",
        ruleId: "tr_1",
        ruleName: null,
        priority: 0,
        selection: "direct",
      }).success,
    ).toBe(false);
  });
});

describe("TestEvaluationResponseSchema", () => {
  it("parses a full response with a live run", () => {
    const res = TestEvaluationResponseSchema.parse({
      variantName: "treatment",
      value: { color: "blue" },
      resolutionReason: "DEFAULT",
      reason: { type: "no_match_default" },
      liveRunId: "run_1",
    });
    expect(res.variantName).toBe("treatment");
    expect(res.liveRunId).toBe("run_1");
  });

  it("accepts a null liveRunId (no Run live, present-with-null)", () => {
    const res = TestEvaluationResponseSchema.parse({
      variantName: "control",
      value: false,
      resolutionReason: "DISABLED",
      reason: { type: "default_disabled" },
      liveRunId: null,
    });
    expect(res.liveRunId).toBeNull();
  });

  it("rejects an omitted liveRunId (present-with-null, never absent)", () => {
    expect(
      TestEvaluationResponseSchema.safeParse({
        variantName: "control",
        value: false,
        resolutionReason: "DISABLED",
        reason: { type: "default_disabled" },
      }).success,
    ).toBe(false);
  });
});
