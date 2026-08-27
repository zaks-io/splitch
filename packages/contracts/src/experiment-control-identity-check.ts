import {
  type FrozenControlIdentity,
  unresolvableControlReasonMessages,
} from "./experiment-control-identity";
import type { DecisionGateCheck } from "./experiment-decision-gate";

export function controlIdentityCheck(control: FrozenControlIdentity): DecisionGateCheck {
  if (control.state === "frozen") {
    return {
      id: "control_identity",
      status: "pass",
      title: "Analysis Control matches the one the Run froze",
      detail: `Every lift is measured against "${control.variant}", the Control this Run froze at Start and Analysis reported for this read. Editing the Experiment's default Variant since then did not move it.`,
    };
  }
  if (control.state === "disagreement") {
    return {
      id: "control_identity",
      status: "fail",
      title: "Analysis Control disagrees with the Run",
      detail: `This Run's frozen Control is "${control.variant}", but the Run Snapshot measured lift against "${control.analysisVariant}". The Run Snapshot cannot be rewritten, so no ship decision can be made for this Run. Start a new Run to get a Control that agrees across both stores.`,
    };
  }
  const froze =
    control.frozenVariantNames.length > 0
      ? `The Run froze ${control.frozenVariantNames.map((name) => `"${name}"`).join(", ")}. `
      : "";
  const reason = unresolvableControlReasonMessages[control.reason];
  const relationshipToRun =
    control.reason === "unreadable_frozen_variant_set" ? "may never have carried" : "never froze";
  return {
    id: "control_identity",
    status: "fail",
    title: "Control Variant cannot be identified",
    detail: `This Run's frozen Control cannot be identified because ${reason}. ${froze}The Experiment's default Variant was backfilled onto this Run as "${control.variantId}", which the Run itself ${relationshipToRun}. The Run Snapshot's Control anchors the lift, but nothing can be promoted against a Control this Run ${relationshipToRun}. Start a new Run to get a Control that is frozen and validated.`,
  };
}
