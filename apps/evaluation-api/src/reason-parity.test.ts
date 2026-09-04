import type {
  EvaluateAllReason,
  EvaluateAllResponse,
  FlagConfigKV,
  ResolutionDetails,
  ResolutionReason,
  TestEvaluationResponse,
  Variant,
} from "@splitch/contracts";
import type { AuthResolver, Principal } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { targetingRule } from "./evaluate/evaluate-path-test-fixtures";
import {
  API_KEY,
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  evaluateAllRouteInit,
  FLAG_KEY,
  makeSdkRouteHarness,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

const EVALUATE_PATH = "/api/sdk/evaluate";
const EVALUATE_ALL_PATH = "/api/sdk/evaluate-all";
const VERIFY_PATH = "/api/sdk/verify";
const TEST_EVAL_PATH = `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/flags/${FLAG_KEY}/test-eval`;
const CONTROL_PLANE_TOKEN = "cp-reason-parity";

const controlPlaneAuthResolver: AuthResolver = (request) => {
  if (request.headers.get("authorization") !== `Bearer ${CONTROL_PLANE_TOKEN}`) {
    return { ok: false, reason: "UNAUTHORIZED" };
  }
  const principal: Principal = {
    kind: "control-plane-token",
    id: "actor-reason-parity",
    scopes: [`app:${APP_ID}:admin`],
    orgId: null,
    appId: APP_ID,
    environmentId: null,
    authDoor: "id_jag",
  };
  return { ok: true, principal };
};

const reasonCases: readonly {
  name: string;
  flagOverrides: Partial<FlagConfigKV>;
  expectedReason: EvaluateAllReason;
  expectedValue: Variant["value"];
  expectedVariantName: string;
}[] = [
  {
    name: "an enabled Flag serving its Default Variant",
    flagOverrides: { experimentId: null, targetingRules: [], rollout: null },
    expectedReason: "DEFAULT",
    expectedValue: false,
    expectedVariantName: "control",
  },
  {
    name: "a baseline Percentage Rollout serve",
    flagOverrides: {
      experimentId: null,
      targetingRules: [],
      rollout: { percentage: 100, salt: "reason-parity-rollout-salt" },
    },
    expectedReason: "SPLIT",
    expectedValue: true,
    expectedVariantName: "treatment",
  },
];

const testEvalParityCases: readonly {
  name: string;
  flagOverrides: Partial<FlagConfigKV>;
  attributes: Record<string, string>;
  expectedReason: ResolutionReason;
  expectedDetail: TestEvaluationResponse["reason"]["type"];
}[] = [
  {
    name: "disabled",
    flagOverrides: { enabled: false, experimentId: null, targetingRules: [], rollout: null },
    attributes: {},
    expectedReason: "DISABLED",
    expectedDetail: "default_disabled",
  },
  {
    name: "enabled Default Variant",
    flagOverrides: { enabled: true, experimentId: null, targetingRules: [], rollout: null },
    attributes: {},
    expectedReason: "DEFAULT",
    expectedDetail: "no_match_default",
  },
  {
    name: "baseline rollout",
    flagOverrides: {
      enabled: true,
      experimentId: null,
      targetingRules: [],
      rollout: { percentage: 100, salt: "test-eval-reason-parity" },
    },
    attributes: {},
    expectedReason: "SPLIT",
    expectedDetail: "baseline_rollout",
  },
  {
    name: "Targeting Rule match",
    flagOverrides: {
      enabled: true,
      experimentId: null,
      targetingRules: [targetingRule({ id: "rule-enterprise" })],
      rollout: null,
    },
    attributes: { plan: "enterprise" },
    expectedReason: "TARGETING_MATCH",
    expectedDetail: "rule_matched",
  },
];

describe("data-plane reason parity", () => {
  it.each(reasonCases)("reports one reason for $name", async (testCase) => {
    const harness = await makeSdkRouteHarness({ flagOverrides: testCase.flagOverrides });
    const client = await sdkClientFor(harness.app);
    const context = {
      targetingKey: "reason-parity-entity",
      idempotencyKey: "reason-parity-evaluation",
    };

    const evaluateResponse = await harness.app.request(
      EVALUATE_PATH,
      sdkRouteInit(CLIENT_KEY, { "idempotency-key": "reason-parity-raw-evaluate" }, context),
    );
    const evaluateValue = await client.evaluate(FLAG_KEY, context);
    const evaluateDetails = await client.evaluateDetails(FLAG_KEY, context);
    const evaluateAll = await client.evaluateAll(context);
    const verify = await client.verify(FLAG_KEY, context);
    const evaluateAllEntry = evaluateAll.evaluations[FLAG_KEY];

    expect(evaluateResponse.status).toBe(200);
    expect(evaluateResponse.headers.get("x-reason")).toBe(testCase.expectedReason);
    expect(evaluateValue).toBe(testCase.expectedValue);
    expect(evaluateDetails).toMatchObject({
      value: testCase.expectedValue,
      variantName: testCase.expectedVariantName,
      reason: testCase.expectedReason,
    });
    expect(evaluateAllEntry).toMatchObject({
      variant: testCase.expectedValue,
      variantName: testCase.expectedVariantName,
      reason: testCase.expectedReason,
    });
    expect(verify).toMatchObject({
      value: testCase.expectedValue,
      variantName: testCase.expectedVariantName,
      reason: testCase.expectedReason,
    });
  });

  it("keeps live-Run no-match Exposure behavior while reporting DEFAULT", async () => {
    const harness = await makeSdkRouteHarness({
      liveRun: true,
      flagOverrides: { targetingRules: [] },
      runOverrides: {
        targetingRules: [
          targetingRule({
            id: "rule-enterprise",
            conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
          }),
        ],
      },
    });
    const bodyOverrides = { attributes: { plan: "free" } };

    const evaluate = await harness.app.request(
      EVALUATE_PATH,
      sdkRouteInit(CLIENT_KEY, {}, bodyOverrides),
    );
    const evaluateAll = await harness.app.request(
      EVALUATE_ALL_PATH,
      evaluateAllRouteInit(CLIENT_KEY, {}, bodyOverrides),
    );
    const verify = await harness.app.request(
      VERIFY_PATH,
      sdkRouteInit(CLIENT_KEY, {}, bodyOverrides),
    );
    const evaluateAllBody = (await evaluateAll.json()) as EvaluateAllResponse;
    const verifyBody = (await verify.json()) as ResolutionDetails;

    expect(evaluate.headers.get("x-reason")).toBe("DEFAULT");
    expect(evaluateAllBody.evaluations[FLAG_KEY]).toMatchObject({
      reason: "DEFAULT",
      exposureTicket: expect.any(String),
    });
    expect(verifyBody.reason).toBe("DEFAULT");
    expect(harness.exposureSink.writes).toHaveLength(1);
  });

  it.each(testEvalParityCases)(
    "gives test-eval and API-Key verify the same flat reason for $name",
    async (testCase) => {
      const harness = await makeSdkRouteHarness({
        door: "binding",
        authResolver: controlPlaneAuthResolver,
        flagOverrides: testCase.flagOverrides,
      });
      const context = {
        targetingKey: "reason-parity-entity",
        attributes: testCase.attributes,
      };

      const testEval = await harness.app.request(TEST_EVAL_PATH, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CONTROL_PLANE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ evaluationContext: { ...context, idType: "user" } }),
      });
      const verify = await harness.app.request(VERIFY_PATH, sdkRouteInit(API_KEY, {}, context));

      expect(testEval.status).toBe(200);
      expect(verify.status).toBe(200);
      const testEvalBody = (await testEval.json()) as TestEvaluationResponse;
      const verifyBody = (await verify.json()) as ResolutionDetails;
      expect(testEvalBody.resolutionReason).toBe(testCase.expectedReason);
      expect(testEvalBody.reason.type).toBe(testCase.expectedDetail);
      expect(verifyBody.reason).toBe(testCase.expectedReason);
    },
  );
});

async function sdkClientFor(app: Awaited<ReturnType<typeof makeSdkRouteHarness>>["app"]) {
  const { createSplitchClient } = await import("@splitch/sdk");
  return createSplitchClient({
    clientKey: CLIENT_KEY,
    endpoint: "https://evaluation.test",
    fetch: ((input: URL | RequestInfo, init?: RequestInit) =>
      app.request(String(input), init)) as typeof fetch,
  });
}
