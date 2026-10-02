import { CURRENT_ANALYSIS_VERSION, canonicalJson } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  decisionSpecFromProposal,
  runCommitmentColumns,
  runDecisionSpecFromBody,
  startProposalFields,
} from "./experiment-start-decision-spec";

const REQUEST_ID = "req_decision_spec";

/** What an omitted target and duration freeze on a sequential Run. */
const SEQUENTIAL_DEFAULTS = {
  targetN: 5000,
  targetNSource: "default",
  plannedDurationDays: 7,
  plannedDurationOverrideReason: null,
} as const;
/** A fixed-horizon Run has no sequential target to default. */
const FIXED_DEFAULTS = {
  targetN: null,
  targetNSource: null,
  plannedDurationDays: 7,
  plannedDurationOverrideReason: null,
} as const;

async function errorBody(response: Response) {
  return (await response.json()) as {
    code: string;
    message: string;
    details: { issues: Array<{ path: string[]; message: string }> };
  };
}

describe("runDecisionSpecFromBody", () => {
  it("defaults an unspecified horizon to sequential with no locked sample size", () => {
    const result = runDecisionSpecFromBody({}, REQUEST_ID);

    expect(result).toEqual({
      ok: true,
      value: { horizon: "sequential", sampleSizeLocked: null, ...SEQUENTIAL_DEFAULTS },
    });
  });

  it("refuses a horizon it cannot honour rather than coercing it to sequential", async () => {
    const result = runDecisionSpecFromBody({ horizon: "bayesian" }, REQUEST_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = await errorBody(result.response);
    expect(body.details.issues[0]?.path).toEqual(["body", "horizon"]);
  });

  it("refuses a fixed horizon with no pre-registered sample size", async () => {
    const result = runDecisionSpecFromBody({ horizon: "fixed" }, REQUEST_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    const body = await errorBody(result.response);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues[0]?.path).toEqual(["body", "sampleSizeLocked"]);
    expect(body.details.issues[0]?.message).toMatch(/required when horizon is 'fixed'/);
  });

  it("refuses a sequential horizon carrying a sample size instead of silently ignoring it", async () => {
    const result = runDecisionSpecFromBody({ sampleSizeLocked: 5000 }, REQUEST_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = await errorBody(result.response);
    expect(body.details.issues[0]?.path).toEqual(["body", "sampleSizeLocked"]);
  });

  it("accepts a fixed horizon with its sample size", () => {
    const result = runDecisionSpecFromBody(
      { horizon: "fixed", sampleSizeLocked: 5000 },
      REQUEST_ID,
    );

    expect(result).toEqual({
      ok: true,
      value: { horizon: "fixed", sampleSizeLocked: 5000, ...FIXED_DEFAULTS },
    });
  });
});

describe("decisionSpecFromProposal", () => {
  it("replays the horizon the proposal recorded, not the one in effect at Review time", () => {
    expect(decisionSpecFromProposal({ horizon: "fixed", sampleSizeLocked: 1200 })).toEqual({
      horizon: "fixed",
      sampleSizeLocked: 1200,
      ...FIXED_DEFAULTS,
    });
  });

  it("reads a proposal with no recorded horizon as the documented default", () => {
    // A proposal recorded before the horizon rode the Approval carries none, and
    // a frozen pending proposal cannot be edited to add one. Refusing it would
    // brick every such Approval Request with a remedy no operator can perform,
    // which is the disguised failure ADR-0036 forbids.
    expect(decisionSpecFromProposal({})).toEqual({
      horizon: "sequential",
      sampleSizeLocked: null,
      ...SEQUENTIAL_DEFAULTS,
    });
    expect(decisionSpecFromProposal({ horizon: null })).toEqual({
      horizon: "sequential",
      sampleSizeLocked: null,
      ...SEQUENTIAL_DEFAULTS,
    });
  });

  it("refuses a horizon the Control Plane cannot honour rather than coercing it", () => {
    expect(decisionSpecFromProposal({ horizon: "bayesian" })).toBeNull();
  });

  it("refuses a proposal whose horizon and sample size disagree, as the ungated Start does", () => {
    expect(decisionSpecFromProposal({ horizon: "fixed" })).toBeNull();
    expect(decisionSpecFromProposal({ sampleSizeLocked: 1200 })).toBeNull();
  });
});

describe("Run commitments at Start (ADR-0059)", () => {
  it("freezes a caller-supplied target_n and records that the caller chose it", () => {
    const result = runDecisionSpecFromBody({ targetN: 12_000 }, REQUEST_ID);

    expect(result).toMatchObject({ ok: true, value: { targetN: 12_000, targetNSource: "caller" } });
  });

  it("refuses a target_n on a fixed-horizon Run, which the engine would refuse to analyze", async () => {
    const result = runDecisionSpecFromBody(
      { horizon: "fixed", sampleSizeLocked: 5000, targetN: 4000 },
      REQUEST_ID,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((await errorBody(result.response)).details.issues[0]?.path).toEqual(["body", "targetN"]);
  });

  it("accepts a planned duration in whole weeks without an override", () => {
    expect(runDecisionSpecFromBody({ plannedDurationDays: 14 }, REQUEST_ID)).toMatchObject({
      ok: true,
      value: { plannedDurationDays: 14, plannedDurationOverrideReason: null },
    });
  });

  it("refuses a planned duration that is not whole weeks unless it carries a reason", async () => {
    const result = runDecisionSpecFromBody({ plannedDurationDays: 3 }, REQUEST_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = (await errorBody(result.response)).details.issues[0];
    expect(issue?.path).toEqual(["body", "plannedDurationDays"]);
    expect(issue?.message).toMatch(/plannedDurationOverrideReason/);
  });

  it("records a labeled override in the locked spec", () => {
    expect(
      runDecisionSpecFromBody(
        { plannedDurationDays: 10, plannedDurationOverrideReason: "holiday code freeze" },
        REQUEST_ID,
      ),
    ).toMatchObject({
      ok: true,
      value: { plannedDurationDays: 10, plannedDurationOverrideReason: "holiday code freeze" },
    });
  });

  it("refuses an override reason on a duration that overrides nothing", async () => {
    const result = runDecisionSpecFromBody(
      { plannedDurationOverrideReason: "just because" },
      REQUEST_ID,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((await errorBody(result.response)).details.issues[0]?.path).toEqual([
      "body",
      "plannedDurationOverrideReason",
    ]);
  });

  it("records caller intent on the proposal so replay resolves defaults identically", () => {
    const spec = runDecisionSpecFromBody({ plannedDurationDays: 21 }, REQUEST_ID);
    if (!spec.ok) throw new Error("expected a valid spec");
    const proposed = startProposalFields({ plannedDurationDays: 21 }, spec.value);

    expect(proposed).toMatchObject({ plannedDurationDays: 21 });
    expect(decisionSpecFromProposal(proposed)).toEqual(spec.value);
  });

  it("keeps a Start that names no commitment at its pre-ADR-0059 idempotency identity", () => {
    const spec = runDecisionSpecFromBody({ reason: "launch" }, REQUEST_ID);
    if (!spec.ok) throw new Error("expected a valid spec");

    expect(canonicalJson(startProposalFields({ reason: "launch" }, spec.value))).toBe(
      canonicalJson({ startReason: "launch", horizon: "sequential", sampleSizeLocked: null }),
    );
  });

  it("replays a caller target and labeled override recorded on a pending proposal", () => {
    expect(
      decisionSpecFromProposal({
        horizon: "sequential",
        sampleSizeLocked: null,
        targetN: 800,
        plannedDurationDays: 4,
        plannedDurationOverrideReason: "launch window",
      }),
    ).toMatchObject({
      targetN: 800,
      targetNSource: "caller",
      plannedDurationDays: 4,
      plannedDurationOverrideReason: "launch window",
    });
  });

  it("refuses a proposal whose recorded duration breaks the policy, as the ungated Start does", () => {
    expect(decisionSpecFromProposal({ plannedDurationDays: 3 })).toBeNull();
  });

  it("stamps the current analysis version when the Run opens", () => {
    const spec = runDecisionSpecFromBody({}, REQUEST_ID);
    if (!spec.ok) throw new Error("expected a valid spec");

    expect(runCommitmentColumns(spec.value)).toMatchObject({
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      targetN: 5000,
      targetNSource: "default",
      plannedDurationDays: 7,
    });
  });
});
