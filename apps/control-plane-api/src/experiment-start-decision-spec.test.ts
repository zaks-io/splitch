import { describe, expect, it } from "vitest";
import {
  decisionSpecFromProposal,
  runDecisionSpecFromBody,
} from "./experiment-start-decision-spec";

const REQUEST_ID = "req_decision_spec";

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

    expect(result).toEqual({ ok: true, value: { horizon: "sequential", sampleSizeLocked: null } });
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

    expect(result).toEqual({ ok: true, value: { horizon: "fixed", sampleSizeLocked: 5000 } });
  });
});

describe("decisionSpecFromProposal", () => {
  it("replays the horizon the proposal recorded, not the one in effect at Review time", () => {
    expect(decisionSpecFromProposal({ horizon: "fixed", sampleSizeLocked: 1200 })).toEqual({
      horizon: "fixed",
      sampleSizeLocked: 1200,
    });
  });

  it("reads a proposal with no recorded horizon as the documented default", () => {
    // A proposal recorded before the horizon rode the Approval carries none, and
    // a frozen pending proposal cannot be edited to add one. Refusing it would
    // brick every such Approval Request with a remedy no operator can perform,
    // which is the disguised failure ADR-0036 forbids.
    expect(decisionSpecFromProposal({})).toEqual({ horizon: "sequential", sampleSizeLocked: null });
    expect(decisionSpecFromProposal({ horizon: null })).toEqual({
      horizon: "sequential",
      sampleSizeLocked: null,
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
