import { beforeAll, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  experimentFixture,
  type ExperimentRunHarness,
  makeExperimentRunHarness,
  startExperiment,
  type StartResponse,
} from "../src/experiment-run-test-fixture.js";
import { analysisEnvelope, statsOutput } from "../src/panel-experiments-test-fixtures.js";
import { analysisReturning, callPanelResults } from "./panel-results-request.js";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings.js";

/**
 * The Analysis Worker's refusals, asserted on the response the Panel receives
 * from the real route.
 *
 * Driving `panelExperimentResults` directly and re-implementing the route's
 * try/catch in the test would leave the wiring in `src/index.ts` untested: the
 * classification could stay correct while the handler that turns a thrown
 * `ScopedAnalysisError` into an HTTP refusal was removed, and the suite would
 * still be green.
 */
let fixture: { appId: string; environmentId: string; experimentId: string; runId: string };

beforeAll(async () => {
  const ctx: ExperimentRunHarness = await makeExperimentRunHarness(makeLocalBindings);
  const fx = await experimentFixture(ctx);
  const experiment = await createExperimentDraft(ctx, fx, {
    key: "results-refusal-exp",
    allocation: { control: 50, treatment: 50 },
    salt: "results-refusal-salt",
    segmentIds: [fx.segmentId],
  });
  const start = await startExperiment(ctx, fx, experiment.id);
  if (start.status !== 200) throw new Error(`start failed: ${start.status} ${await start.text()}`);
  const started = (await start.json()) as StartResponse;
  fixture = {
    appId: fx.appId,
    environmentId: fx.environmentId,
    experimentId: experiment.id,
    runId: started.run.id,
  };
});

describe("panel Experiment Results route refusals", () => {
  it("answers a Run-provenance mismatch with a permanent refusal", async () => {
    const response = await callPanelResults(
      analysisReturning(Response.json(analysisEnvelope("run_somewhere_else", statsOutput()))),
      fixture,
    );

    await expectRefusal(response, { status: 500, code: "INTERNAL_SERVER_ERROR" });
  });

  // The Worker states whether waiting can help. Classifying on the HTTP status
  // alone would file this permanent integrity failure under "try again shortly".
  it("keeps a typed permanent failure permanent when it arrives as a 503", async () => {
    const response = await callPanelResults(
      analysisReturning(
        Response.json(
          { code: "INTERNAL_SERVER_ERROR", message: "run provenance mismatch", details: {} },
          { status: 503 },
        ),
      ),
      fixture,
    );

    await expectRefusal(response, { status: 500, code: "INTERNAL_SERVER_ERROR" });
  });

  it("keeps a typed transient failure retryable when it arrives as a 500", async () => {
    const response = await callPanelResults(
      analysisReturning(
        Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "analysis data is unavailable",
            details: { retryAfterMs: 30_000 },
          },
          { status: 500 },
        ),
      ),
      fixture,
    );

    const body = await expectRefusal(response, { status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(body.details).toMatchObject({ retryAfterMs: 30_000 });
  });

  // With no typed body there is nothing to poll on, so advertising a retry would
  // turn a loud failure into a quiet wait.
  it("refuses an untyped upstream failure permanently", async () => {
    const response = await callPanelResults(
      analysisReturning(Response.json({ unexpected: true }, { status: 500 })),
      fixture,
    );

    await expectRefusal(response, { status: 500, code: "INTERNAL_SERVER_ERROR" });
  });
});

async function expectRefusal(
  response: Response,
  expected: { status: number; code: string },
): Promise<{ code: string; details: Record<string, unknown> }> {
  expect(response.status).toBe(expected.status);
  const body = (await response.json()) as { code: string; details: Record<string, unknown> };
  expect(body.code).toBe(expected.code);
  if (expected.status !== 503) expect(body.details).not.toHaveProperty("retryAfterMs");
  return body;
}
