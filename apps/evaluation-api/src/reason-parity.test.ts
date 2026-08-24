import type {
  EvaluateAllEntry,
  EvaluateAllReason,
  EvaluateAllResponse,
  FlagConfigKV,
  ResolutionDetails,
  Variant,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { targetingRule } from "./evaluate/evaluate-path-test-fixtures";
import {
  CLIENT_KEY,
  evaluateAllRouteInit,
  FLAG_KEY,
  makeSdkRouteHarness,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

const EVALUATE_PATH = "/api/sdk/evaluate";
const EVALUATE_ALL_PATH = "/api/sdk/evaluate-all";
const VERIFY_PATH = "/api/sdk/verify";

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
});

async function sdkClientFor(app: Awaited<ReturnType<typeof makeSdkRouteHarness>>["app"]) {
  const path = new URL("../../../packages/sdk/src/client.ts", import.meta.url).href;
  const { createSplitchClient } = (await import(/* @vite-ignore */ path)) as {
    createSplitchClient(options: { clientKey: string; endpoint: string; fetch: typeof fetch }): {
      evaluate(flagKey: string, context: EvaluationContext): Promise<Variant["value"]>;
      evaluateDetails(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>;
      evaluateAll(context: EvaluationContext): Promise<{
        evaluations: Readonly<Record<string, EvaluateAllEntry>>;
      }>;
      verify(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>;
    };
  };
  return createSplitchClient({
    clientKey: CLIENT_KEY,
    endpoint: "https://evaluation.test",
    fetch: ((input: URL | RequestInfo, init?: RequestInit) =>
      app.request(String(input), init)) as typeof fetch,
  });
}

interface EvaluationContext {
  readonly targetingKey: string;
  readonly idempotencyKey: string;
}
