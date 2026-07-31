import type { MetricRef } from "@splitch/contracts";
import type { ExperimentRow } from "./experiment-model";
import { jsonArray } from "./experiment-model";
import { validationErrors } from "./flag-definition-errors";

/**
 * The decision spec a Run freezes at Start (ADR-0003): confidence level, horizon
 * mode, goal Metric family, Guardrail thresholds, Primary Dimensions. Everything
 * but the horizon is carried on the Experiment and frozen from it; the horizon
 * lives only on the Run (storage-schemas-d1-experiment.md), so it is chosen in
 * the Start request itself.
 *
 * Both checks here answer the same question — "is this draft decidable?" — and
 * both answer it BEFORE any state moves, naming the missing piece per field so
 * the caller is told what to fix rather than that something was wrong.
 */

export interface RunDecisionSpec {
  horizon: "sequential" | "fixed";
  sampleSizeLocked: number | null;
}

function isRunHorizon(value: unknown): value is RunDecisionSpec["horizon"] {
  return value === "sequential" || value === "fixed";
}

export function runDecisionSpecFromBody(
  body: Record<string, unknown>,
  requestId: string,
): { ok: true; value: RunDecisionSpec } | { ok: false; response: Response } {
  // Absent means sequential (the documented default); anything else present is a
  // horizon the Control Plane cannot honour, and coercing it to sequential would
  // silently register a different stopping rule than the caller asked for.
  if (body.horizon !== undefined && !isRunHorizon(body.horizon)) {
    return {
      ok: false,
      response: validationErrors(requestId, [
        {
          path: ["body", "horizon"],
          message: "horizon must be 'sequential' or 'fixed'",
        },
      ]),
    };
  }
  const horizon = body.horizon === "fixed" ? "fixed" : "sequential";
  const sampleSizeLocked = typeof body.sampleSizeLocked === "number" ? body.sampleSizeLocked : null;
  if (horizon === "fixed" && sampleSizeLocked === null) {
    return {
      ok: false,
      response: validationErrors(requestId, [
        {
          path: ["body", "sampleSizeLocked"],
          message:
            "a fixed-horizon Run decides at a pre-registered sample size, so sampleSizeLocked is required when horizon is 'fixed'",
        },
      ]),
    };
  }
  // A sample size on a sequential Run would be stored and never read: sequential
  // inference is always-valid and has no horizon to reach (ADR-0014), so the
  // Run's "horizon reached" attention signal would never fire for it. Refuse
  // rather than accept a number that quietly means nothing.
  if (horizon === "sequential" && sampleSizeLocked !== null) {
    return {
      ok: false,
      response: validationErrors(requestId, [
        {
          path: ["body", "sampleSizeLocked"],
          message:
            "a sequential Run is decided by always-valid inference and never reaches a locked sample size; set horizon to 'fixed' to pre-register one",
        },
      ]),
    };
  }
  return { ok: true, value: { horizon, sampleSizeLocked } };
}

/**
 * A Run with an empty goal Metric family freezes a decision spec that can decide
 * nothing: every Metric added afterwards is exploratory (ADR-0003), so the Run
 * can never produce a decision-valid result. Refusing at Start is the only point
 * where that is still fixable.
 */
export function startReadinessResponse(
  experiment: ExperimentRow,
  requestId: string,
): Response | null {
  if (jsonArray<MetricRef>(experiment.metrics).length > 0) return null;
  return validationErrors(requestId, [
    {
      path: ["experiment", "metrics"],
      message:
        "Start freezes the goal Metric family into the Run and every later addition is exploratory, so an Experiment with no goal Metric can never produce a decision-valid result. Add at least one goal Metric before Start.",
    },
  ]);
}

/**
 * Everything a Start request contributes to the Approval proposal, derived once.
 * The Approval `proposed` record and the idempotency `proposalInput` are both
 * built from this return value, so the recorded intent and the hash that
 * identifies it cannot drift: a Start replayed under the same Idempotency-Key
 * with different intent hashes differently and is refused rather than silently
 * replaying the proposal it does not match (ADR-0036).
 */
export function startProposalFields(
  body: Record<string, unknown>,
  decisionSpec: RunDecisionSpec,
): {
  startReason: string | null;
  horizon: RunDecisionSpec["horizon"];
  sampleSizeLocked: number | null;
} {
  return {
    startReason: typeof body.reason === "string" ? body.reason : null,
    horizon: decisionSpec.horizon,
    sampleSizeLocked: decisionSpec.sampleSizeLocked,
  };
}

/**
 * The horizon the Approval Request recorded, replayed when a gated Start is
 * applied. An Approval that cannot be read back to the same Run config would
 * apply a different Run than the one reviewed.
 */
export function decisionSpecFromProposal(
  proposed: Record<string, unknown>,
): RunDecisionSpec | null {
  // Absent means sequential here for the same reason it does on the request:
  // it is the documented default. A proposal recorded before the horizon rode
  // the Approval carries none, and refusing it would brick every pending
  // `experiment_start` Approval Request with a remedy no operator can perform —
  // a frozen proposal cannot be edited to add the field (ADR-0036).
  const proposedHorizon = proposed.horizon ?? "sequential";
  if (!isRunHorizon(proposedHorizon)) return null;
  const horizon = proposedHorizon;
  const sampleSizeLocked =
    typeof proposed.sampleSizeLocked === "number" ? proposed.sampleSizeLocked : null;
  // The same pairing the ungated Start refuses with a 400. A proposal that
  // breaks it is a malformed row, and applying it would store a stopping rule
  // the ungated path would never have written.
  if ((horizon === "fixed") !== (sampleSizeLocked !== null)) return null;
  return { horizon, sampleSizeLocked };
}
