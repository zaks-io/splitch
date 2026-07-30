import { describe, expect, it } from "vitest";
import { resolveFrozenControlIdentity } from "./experiment-control-identity";
import { check, gateFor, stats } from "./experiment-decision-gate-test-fixtures";

const variantSet = JSON.stringify([
  { id: "variant_a", name: "control", value: false },
  { id: "variant_b", name: "treatment", value: true },
]);

describe("resolveFrozenControlIdentity", () => {
  it("names the Control by the frozen id, not by the name 'control'", () => {
    const control = resolveFrozenControlIdentity("variant_b", variantSet);
    expect(control).toEqual({ state: "frozen", variantId: "variant_b", variant: "treatment" });
  });

  it("refuses a Control the Run never froze instead of picking an arm", () => {
    const control = resolveFrozenControlIdentity("variant_from_a_later_edit", variantSet);
    expect(control).toEqual({
      state: "unresolvable",
      variantId: "variant_from_a_later_edit",
      reason: "absent_from_frozen_variant_set",
      frozenVariantNames: ["control", "treatment"],
    });
  });

  it.each([
    ["not json", "{{"],
    ["not an array", '{"id":"variant_a","name":"control"}'],
    ["missing the fields it needs", '[{"id":"variant_a"}]'],
  ])("refuses a frozen Variant set that is %s", (_case, json) => {
    const control = resolveFrozenControlIdentity("variant_a", json);
    expect(control).toEqual({
      state: "unresolvable",
      variantId: "variant_a",
      reason: "unreadable_frozen_variant_set",
      frozenVariantNames: [],
    });
  });
});

describe("control_identity gate check", () => {
  it("passes on a frozen Control and says the Experiment's default cannot move it", () => {
    const identity = check(gateFor(stats()), "control_identity");
    expect(identity.status).toBe("pass");
    expect(identity.detail).toContain("froze at Start");
  });

  it("blocks the ship decision when the Control cannot be identified", () => {
    const gate = gateFor(stats(), {
      state: "unresolvable",
      variantId: "variant_from_a_later_edit",
      reason: "absent_from_frozen_variant_set",
      frozenVariantNames: ["control", "treatment"],
    });
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toContain("control_identity");
    const identity = check(gate, "control_identity");
    expect(identity.detail).toContain("variant_from_a_later_edit");
    expect(identity.detail).toContain("absent_from_frozen_variant_set");
  });

  it("keeps every other check reported so the refusal is not the only thing on the page", () => {
    const gate = gateFor(stats(), {
      state: "unresolvable",
      variantId: "variant_gone",
      reason: "unreadable_frozen_variant_set",
      frozenVariantNames: [],
    });
    expect(gate.checks.map((entry) => entry.id)).toEqual([
      "control_identity",
      "exposure_srm",
      "activated_srm",
      "activation_balance",
      "engine_status",
      "underpowered",
      "decision_valid_result",
    ]);
  });
});
