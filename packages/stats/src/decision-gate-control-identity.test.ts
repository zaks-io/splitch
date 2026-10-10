import { describe, expect, it } from "vitest";
import { check, gateFor, stats } from "./decision-gate-test-fixtures";

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
      'This Run\'s frozen Control cannot be identified because it is absent from the Variant set this Run froze. The Run froze "control", "treatment". The Experiment\'s default Variant was backfilled onto this Run as "variant_from_a_later_edit", which the Run itself never froze. The Run Snapshot\'s Control anchors the lift, but nothing can be promoted against a Control this Run never froze. Start a new Run to get a Control that is frozen and validated.',
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
      "planned_duration",
      "decision_valid_result",
    ]);
    expect(check(gate, "control_identity").detail).toBe(
      "This Run's frozen Control cannot be identified because the frozen Variant set could not be read. The Experiment's default Variant was backfilled onto this Run as \"variant_gone\", which the Run itself may never have carried. The Run Snapshot's Control anchors the lift, but nothing can be promoted against a Control this Run may never have carried. Start a new Run to get a Control that is frozen and validated.",
    );
  });
});
