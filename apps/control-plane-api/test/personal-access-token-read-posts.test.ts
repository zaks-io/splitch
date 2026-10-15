import { env } from "cloudflare:workers";
import { DELEGATED_IDENTITY_HEADER } from "@splitch/worker-runtime";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OWNER, recordingBinding, TENANT_A } from "./index-mcp-fixtures";
import { call, resetPatMcpToken, setupPatMcpFixture } from "./personal-access-token-mcp-fixture";

const analysisRequests: Request[] = [];
const evaluationRequests: Request[] = [];
const results = {
  state: "no_data",
  run_id: TENANT_A.runId,
  control_variant: "control",
  missing: "metric_events",
};
const evaluation = {
  variantName: "control",
  value: false,
  resolutionReason: "DEFAULT",
  reason: { type: "no_match_default" },
  liveRunId: null,
};
const app = `/apps/${TENANT_A.appId}`;
const environment = `${app}/envs/${TENANT_A.environmentId}`;
const experiment = `${environment}/experiments/${TENANT_A.experimentId}`;

beforeAll(async () => {
  await setupPatMcpFixture({
    ANALYSIS_API: recordingBinding(analysisRequests, results),
    EVALUATION_API: recordingBinding(evaluationRequests, evaluation),
  });
  await env.DB.prepare("UPDATE experiments SET default_variant_id = ? WHERE app_id = ? AND id = ?")
    .bind(`${TENANT_A.flagId}_control`, TENANT_A.appId, TENANT_A.experimentId)
    .run();
});
beforeEach(async () => {
  await resetPatMcpToken();
  analysisRequests.length = 0;
  evaluationRequests.length = 0;
});

describe("read-only PAT through the signed MCP entrypoint", () => {
  it("plans an Experiment through POST without a write grant", async () => {
    const response = await call("experiment_plan", "POST", `${environment}/experiment-plan`, {
      metricKind: "continuous",
      baselineMean: 10,
      baselineVariance: 25,
      armCount: 2,
      mdeAbsolute: 0.5,
      expectedDailyEligibleEntities: 2000,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      targetN: expect.any(Number),
      baselineSource: "caller",
    });
    expect(analysisRequests).toHaveLength(0);
    expect(evaluationRequests).toHaveLength(0);
  });

  it("allows POST test evaluation and delegates the read authority to Evaluation", async () => {
    const body = {
      evaluationContext: { targetingKey: "pat-read-user", idType: "user", attributes: {} },
    };
    const response = await call(
      "flags_test_eval",
      "POST",
      `${environment}/flags/${TENANT_A.flagKey}/test-eval`,
      body,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual(evaluation);
    expect(evaluationRequests).toHaveLength(1);
    expect(analysisRequests).toHaveLength(0);
    const forwarded = evaluationRequests[0];
    if (!forwarded) throw new Error("Evaluation binding was not called");
    expect(await forwarded.json()).toEqual(body);
    expect(JSON.parse(forwarded.headers.get(DELEGATED_IDENTITY_HEADER) ?? "null")).toMatchObject({
      operation: "flags_test_eval",
      actorId: OWNER,
      appId: TENANT_A.appId,
      scopes: [`app:${TENANT_A.appId}:owner`],
    });
  });

  it("allows POST results and delegates the read authority to Analysis", async () => {
    const response = await call("experiment_results_post", "POST", `${experiment}/results`, {});
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      ...results,
      view: "detailed",
      run_status: "running",
      control: { state: "frozen", variant: "control" },
      readiness: { statistical: false, concludeExecutable: false },
    });
    expect(analysisRequests).toHaveLength(1);
    expect(evaluationRequests).toHaveLength(0);
    const forwarded = analysisRequests[0];
    if (!forwarded) throw new Error("Analysis binding was not called");
    expect(JSON.parse(forwarded.headers.get(DELEGATED_IDENTITY_HEADER) ?? "null")).toMatchObject({
      operation: "experiment_results_post",
      actorId: OWNER,
      appId: TENANT_A.appId,
      scopes: [`app:${TENANT_A.appId}:owner`],
    });
  });

  it.each([
    ["experiments_get", experiment, TENANT_A.experimentId],
    ["runs_get", `${experiment}/runs/${TENANT_A.runId}`, TENANT_A.runId],
  ])("reads %s from D1 without any mutation permission", async (operation, path, id) => {
    const response = await call(operation, "GET", path);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ id });
    expect(analysisRequests).toHaveLength(0);
    expect(evaluationRequests).toHaveLength(0);
  });
});
