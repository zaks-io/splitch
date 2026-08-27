import { describe, expect, it } from "vitest";
import {
  ConfigPatchSchema,
  ReviewInputSchema,
  TargetingEditInputSchema,
  UpdateConfigInputSchema,
} from "./flag-mutation-input";

/**
 * A server function is a public HTTP endpoint. Everything here is reachable by an
 * unauthenticated caller with a crafted body, so each defense gets a test that
 * fails if the defense is relaxed — otherwise the only thing holding the surface
 * shut is that nobody has edited the schema yet.
 */

const scope = { appId: "app_1", environmentId: "env_prod", flagId: "flag_1" };

describe("Flag Configuration patch input", () => {
  it("accepts the three fields the Configuration route actually takes", () => {
    const parsed = ConfigPatchSchema.safeParse({
      enabled: true,
      availableVariantNames: ["control", "treatment"],
      rollout: { percentage: 25 },
    });

    expect(parsed.success).toBe(true);
  });

  /**
   * Kills `.strict()` -> `.passthrough()`. An unknown key is not harmless here: it
   * is forwarded verbatim into the Control Plane patch body, so a passthrough
   * schema turns this function into an open proxy for fields the panel never
   * intended to expose.
   */
  it("rejects an unknown key rather than forwarding it to the Control Plane", () => {
    expect(ConfigPatchSchema.safeParse({ enabled: true, defaultVariantId: "var_x" }).success).toBe(
      false,
    );
    expect(ConfigPatchSchema.safeParse({ experimentId: "exp_1" }).success).toBe(false);
  });

  /**
   * Kills the removal of `.strict()` on `rollout`. The bucketing salt IS the
   * assignment: a caller-supplied one would silently reshuffle who is in the
   * rollout, which is why the server mints it once and never accepts one
   * (endpoints-flag-segment.md).
   */
  it("rejects a caller-supplied bucketing salt", () => {
    expect(
      ConfigPatchSchema.safeParse({ rollout: { percentage: 50, salt: "attacker-chosen" } }).success,
    ).toBe(false);
  });

  /** Kills the removal of `.min(0)` / `.max(100)` on the rollout percentage. */
  it("rejects a rollout percentage outside 0-100", () => {
    expect(ConfigPatchSchema.safeParse({ rollout: { percentage: -1 } }).success).toBe(false);
    expect(ConfigPatchSchema.safeParse({ rollout: { percentage: 101 } }).success).toBe(false);
    expect(ConfigPatchSchema.safeParse({ rollout: { percentage: 0 } }).success).toBe(true);
    expect(ConfigPatchSchema.safeParse({ rollout: { percentage: 100 } }).success).toBe(true);
  });

  it("keeps `null` distinguishable from omitted, so clearing the baseline stays expressible", () => {
    expect(ConfigPatchSchema.safeParse({ rollout: null }).success).toBe(true);
    expect(ConfigPatchSchema.safeParse({}).success).toBe(true);
  });
});

describe("Flag Configuration write scope", () => {
  /**
   * Kills the removal of `.min(1)` on the idempotency key. An empty key parses as
   * a string but cannot identify a submission, so the Control Plane loses its only
   * way to recognize a replay and a retried write applies twice.
   */
  it("rejects an empty idempotency key", () => {
    expect(
      UpdateConfigInputSchema.safeParse({ ...scope, patch: { enabled: true }, idempotencyKey: "" })
        .success,
    ).toBe(false);
    expect(
      ReviewInputSchema.safeParse({
        appId: "app_1",
        approvalRequestId: "apr_1",
        action: "approve_and_apply",
        idempotencyKey: "",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty scope id in any position", () => {
    for (const field of ["appId", "environmentId", "flagId"] as const) {
      const parsed = UpdateConfigInputSchema.safeParse({
        ...scope,
        [field]: "",
        patch: { enabled: true },
        idempotencyKey: "key_1",
      });
      expect(parsed.success, `${field} must not accept an empty string`).toBe(false);
    }
  });

  it("rejects a Review action outside the two the contract defines", () => {
    expect(
      ReviewInputSchema.safeParse({
        appId: "app_1",
        approvalRequestId: "apr_1",
        action: "approve",
        idempotencyKey: "key_1",
      }).success,
    ).toBe(false);
  });
});

describe("Targeting Rule edit input", () => {
  it("accepts the two edit shapes the editor can express", () => {
    expect(
      TargetingEditInputSchema.safeParse({
        ...scope,
        edit: { kind: "remove", ruleId: "rule_1" },
        idempotencyKey: "key_1",
      }).success,
    ).toBe(true);
    expect(
      TargetingEditInputSchema.safeParse({
        ...scope,
        edit: {
          kind: "add",
          ruleId: "rule_1",
          condition: { attribute: "plan", operator: "eq", value: "pro" },
          variantId: "var_treatment",
        },
        idempotencyKey: "key_1",
      }).success,
    ).toBe(true);
    expect(
      TargetingEditInputSchema.safeParse({
        ...scope,
        edit: {
          kind: "add",
          ruleId: "rule_percentage",
          condition: { attribute: "plan", operator: "eq", value: "pro" },
          variantId: "var_treatment",
          percentage: 25,
        },
        idempotencyKey: "key_percentage",
      }).success,
    ).toBe(true);
  });

  /**
   * The browser expresses only the percentage scalar. Accepting the raw rollout
   * object would let it smuggle a caller-chosen salt into the server function.
   */
  it("rejects a caller-supplied rule rollout object", () => {
    expect(
      TargetingEditInputSchema.safeParse({
        ...scope,
        edit: {
          kind: "add",
          ruleId: "rule_1",
          condition: { attribute: "plan", operator: "eq", value: "pro" },
          variantId: "var_treatment",
          percentageRollout: { percentage: 50, salt: "attacker-chosen" },
        },
        idempotencyKey: "key_1",
      }).success,
    ).toBe(false);
  });

  it("rejects a rule percentage outside 0-100", () => {
    const input = (percentage: number) => ({
      ...scope,
      edit: {
        kind: "add" as const,
        ruleId: "rule_1",
        condition: { attribute: "plan", operator: "eq" as const, value: "pro" },
        variantId: "var_treatment",
        percentage,
      },
      idempotencyKey: "key_1",
    });

    expect(TargetingEditInputSchema.safeParse(input(-1)).success).toBe(false);
    expect(TargetingEditInputSchema.safeParse(input(101)).success).toBe(false);
    expect(TargetingEditInputSchema.safeParse(input(0)).success).toBe(true);
    expect(TargetingEditInputSchema.safeParse(input(100)).success).toBe(true);
  });

  it("rejects an operator the evaluation path does not implement", () => {
    expect(
      TargetingEditInputSchema.safeParse({
        ...scope,
        edit: {
          kind: "add",
          ruleId: "rule_1",
          attribute: "plan",
          operator: "regex",
          value: ".*",
          variantId: "var_treatment",
        },
        idempotencyKey: "key_1",
      }).success,
    ).toBe(false);
  });
});
