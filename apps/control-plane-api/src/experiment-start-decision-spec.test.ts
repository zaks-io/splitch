import { describe, expect, it } from "vitest";
import type { ExperimentRow } from "./experiment-model";
import {
  decisionSpecFromProposal,
  runDecisionSpecFromBody,
  startReadinessResponse,
} from "./experiment-start-decision-spec";

const REQUEST_ID = "req_decision_spec";

async function errorBody(response: Response) {
  return (await response.json()) as {
    code: string;
    message: string;
    details: { issues: Array<{ path: string[]; message: string }> };
  };
}

function experimentRow(metrics: string): ExperimentRow {
  return { metrics } as unknown as ExperimentRow;
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

describe("startReadinessResponse", () => {
  it("passes an Experiment that has a goal Metric family", () => {
    expect(startReadinessResponse(experimentRow('[{"id":"met_1"}]'), REQUEST_ID)).toBeNull();
  });

  it("refuses Start with an empty goal Metric family, naming the field", async () => {
    const response = startReadinessResponse(experimentRow("[]"), REQUEST_ID);

    expect(response).not.toBeNull();
    const body = await errorBody(response as Response);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues[0]?.path).toEqual(["experiment", "metrics"]);
    expect(body.details.issues[0]?.message).toMatch(/goal Metric/);
  });
});

describe("decisionSpecFromProposal", () => {
  it("replays the horizon the proposal recorded, not the one in effect at Review time", () => {
    expect(decisionSpecFromProposal({ horizon: "fixed", sampleSizeLocked: 1200 })).toEqual({
      horizon: "fixed",
      sampleSizeLocked: 1200,
    });
  });

  it("refuses a proposal that names no horizon rather than inferring one", () => {
    // Start always writes the horizon onto the proposal, so a proposal without
    // one is a malformed row. Reading it back as sequential would freeze a
    // stopping rule nobody chose onto the Run (ADR-0036).
    expect(decisionSpecFromProposal({})).toBeNull();
    expect(decisionSpecFromProposal({ horizon: "bayesian" })).toBeNull();
  });

  it("refuses a proposal whose horizon and sample size disagree, as the ungated Start does", () => {
    expect(decisionSpecFromProposal({ horizon: "fixed" })).toBeNull();
    expect(decisionSpecFromProposal({ sampleSizeLocked: 1200 })).toBeNull();
  });
});
