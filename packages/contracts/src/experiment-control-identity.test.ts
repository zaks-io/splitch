import { describe, expect, it } from "vitest";
import {
  resolveAnalysisControlIntegrity,
  resolveFrozenControlIdentity,
} from "./experiment-control-identity";
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

describe("resolveAnalysisControlIntegrity", () => {
  const frozen = { state: "frozen" as const, variantId: "variant_a", variant: "control" };

  it("keeps the frozen identity when Analysis agrees", () => {
    expect(resolveAnalysisControlIntegrity(frozen, "control")).toEqual(frozen);
  });

  it("names both Controls when Analysis disagrees", () => {
    expect(resolveAnalysisControlIntegrity(frozen, "legacy_checkout")).toEqual({
      state: "disagreement",
      variantId: "variant_a",
      variant: "control",
      analysisVariant: "legacy_checkout",
    });
  });

  it("adds the Analysis Control to an unresolvable frozen Control", () => {
    const unresolvable = {
      state: "unresolvable" as const,
      variantId: "variant_missing",
      reason: "absent_from_frozen_variant_set" as const,
      frozenVariantNames: ["control", "treatment"],
    };

    expect(resolveAnalysisControlIntegrity(unresolvable, "control")).toEqual({
      ...unresolvable,
      analysisVariant: "control",
    });
  });

  it("fails loudly when the Analysis Control name is missing", () => {
    const unresolvable = {
      state: "unresolvable" as const,
      variantId: "variant_missing",
      reason: "absent_from_frozen_variant_set" as const,
      frozenVariantNames: ["control", "treatment"],
    };

    expect(() => resolveAnalysisControlIntegrity(unresolvable, "")).toThrow(
      "Analysis Control name is missing from resolveAnalysisControlIntegrity input",
    );
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
      analysisVariant: "control",
    });
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toContain("control_identity");
    const identity = check(gate, "control_identity");
    expect(identity.detail).toBe(
      'This Run\'s frozen Control cannot be identified because it is absent from the Variant set this Run froze. The Run froze "control", "treatment". The Experiment\'s default Variant was backfilled onto this Run as "variant_from_a_later_edit", which the Run itself never froze. Nothing can be promoted against a baseline this Run never recorded, and guessing one would invent provenance. Start a new Run to get a Control that is frozen and validated.',
    );
    expect(identity.detail).not.toContain("absent_from_frozen_variant_set");
  });

  it("blocks the ship decision when Analysis reports a different Control", () => {
    const gate = gateFor(stats(), {
      state: "disagreement",
      variantId: "variant_control",
      variant: "control",
      analysisVariant: "legacy_checkout",
    });

    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toContain("control_identity");
    const identity = check(gate, "control_identity");
    expect(identity.title).toContain("disagrees");
    expect(identity.detail).toBe(
      'This Run\'s frozen Control is "control", but the Run Snapshot measured lift against "legacy_checkout". The Run Snapshot cannot be rewritten, so no ship decision can be made for this Run. Start a new Run to get a Control that agrees across both stores.',
    );
  });

  it("keeps every other check reported so the refusal is not the only thing on the page", () => {
    const gate = gateFor(stats(), {
      state: "unresolvable",
      variantId: "variant_gone",
      reason: "unreadable_frozen_variant_set",
      frozenVariantNames: [],
      analysisVariant: "control",
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
