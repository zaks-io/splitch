import {
  EvaluationContextSchema,
  experimentConfigKey,
  flagConfigKey,
  type ErrorResponse,
  type TestEvaluationResponse,
} from "@splitch/contracts";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { createApp } from "./app";
import { makeDataPlaneAuthResolver } from "./data-plane-auth";
import {
  MISSING_ATTR_PARITY_CASES,
  PARITY_BASELINE_ROLLOUT,
  PARITY_PLAN_RULE_ID,
  type ParityAttributes,
} from "./evaluate-test-eval-parity-cases";
import { evaluatePath } from "./evaluate/evaluate-path";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  RecordingAssignmentStore,
  RecordingProvider,
  baseInput,
  experimentConfig,
  flagConfig,
  targetingRule,
} from "./evaluate/evaluate-path-test-fixtures";
import { FakeKv } from "./provider/fake-kv";
import { experimentConfigKV, flagConfigKV } from "./provider/fixtures";
import { KvProvider } from "./provider/kv-provider";
import {
  CLIENT_KEY,
  RecordingEvaluationCommitSink,
  RecordingEvaluationUsageSink,
  RecordingExposureSink,
  makeSdkRouteHarness,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

const TEST_EVAL_PATH = `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/flags/${FLAG_KEY}/test-eval`;
const EVALUATE_PATH = "/api/sdk/evaluate";
const CONTROL_PLANE_TOKEN = "cp-parity-app-A";

const allowLimiter: RateLimiter = () => ({ limited: false });

function controlPlanePrincipal(appId: string): Principal {
  return {
    kind: "control-plane-token",
    id: "actor-parity",
    scopes: [`app:${appId}:admin`],
    orgId: null,
    appId,
    environmentId: null,
    authDoor: "id_jag",
  };
}

const controlPlaneAuthResolver: AuthResolver = (request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === `Bearer ${CONTROL_PLANE_TOKEN}`) {
    return { ok: true, principal: controlPlanePrincipal(APP_ID) };
  }
  return { ok: false, reason: "UNAUTHORIZED" };
};

function wireAttributes(attributes: ParityAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null) {
      throw new Error(`parity http case must not carry null attribute "${key}"`);
    }
    out[key] = value;
  }
  return out;
}

function parityFlag() {
  return flagConfig({
    experimentId: EXPERIMENT_ID,
    rollout: { ...PARITY_BASELINE_ROLLOUT },
    targetingRules: [
      targetingRule({
        id: PARITY_PLAN_RULE_ID,
        conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
        variantId: "v-treatment",
      }),
    ],
  });
}

function parityFlagKv() {
  return flagConfigKV({
    experimentId: EXPERIMENT_ID,
    rollout: { ...PARITY_BASELINE_ROLLOUT },
    targetingRules: [
      targetingRule({
        id: PARITY_PLAN_RULE_ID,
        conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
        variantId: "v-treatment",
      }),
    ],
  });
}

async function makeParityHttpHarness() {
  const configKv = new FakeKv()
    .put(flagConfigKey(APP_ID, ENVIRONMENT_ID, FLAG_KEY), parityFlagKv())
    .put(
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
      experimentConfigKV({ liveRunId: null, status: "draft" }),
    );

  const sdk = await makeSdkRouteHarness({
    door: "binding",
    liveRun: false,
    flagOverrides: {
      experimentId: EXPERIMENT_ID,
      rollout: { ...PARITY_BASELINE_ROLLOUT },
      targetingRules: [
        targetingRule({
          id: PARITY_PLAN_RULE_ID,
          conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
          variantId: "v-treatment",
        }),
      ],
    },
  });

  // Replace the public-only control-plane stub with a real resolver so binding
  // door test-eval and Client Key evaluate share one Worker instance + KV.
  const app = createApp({
    door: "binding",
    authResolver: controlPlaneAuthResolver,
    dataPlaneAuthResolver: makeDataPlaneAuthResolver(sdk.credentialKv),
    rateLimiter: allowLimiter,
    provider: new KvProvider(configKv),
    assignmentStore: sdk.assignmentStore,
    exposureAssembly: {
      saltStore: new StaticSaltStore(),
      sourceId: "pop-parity",
    },
    evaluationCommitSink: new RecordingEvaluationCommitSink(
      new RecordingExposureSink(),
      new RecordingEvaluationUsageSink(),
    ),
    evaluationUsageSink: new RecordingEvaluationUsageSink(),
  });

  return { app };
}

describe("test-eval ↔ evaluate missing-attribute parity (shared case table)", () => {
  const pathCases = MISSING_ATTR_PARITY_CASES.filter((c) => c.surfaces.includes("path"));
  const httpCases = MISSING_ATTR_PARITY_CASES.filter((c) => c.surfaces.includes("http"));

  it.each(pathCases)("$name — evaluatePath", async (parityCase) => {
    const result = await evaluatePath(
      baseInput({
        evaluationContext: {
          targetingKey: "user-parity",
          idType: "user",
          attributes: parityCase.attributes as never,
        },
      }),
      {
        assignmentStore: new RecordingAssignmentStore(),
        provider: new RecordingProvider({
          flag: parityFlag(),
          experiment: experimentConfig({ liveRun: null }),
        }),
      },
    );

    expect(result.kind).not.toBe("error");
    expect(result).toMatchObject({
      variant: parityCase.expect.variantName,
      reason: { type: parityCase.expect.reasonType },
    });
  });

  it.each(httpCases)("$name — test-eval and evaluate agree", async (parityCase) => {
    const { app } = await makeParityHttpHarness();
    const attributes = wireAttributes(parityCase.attributes);

    const testEvalRes = await app.request(TEST_EVAL_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CONTROL_PLANE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        evaluationContext: {
          targetingKey: "user-parity",
          idType: "user",
          attributes,
        },
      }),
    });
    const evaluateRes = await app.request(
      EVALUATE_PATH,
      sdkRouteInit(
        CLIENT_KEY,
        {},
        {
          targetingKey: "user-parity",
          idType: "user",
          attributes,
        },
      ),
    );

    expect(testEvalRes.status).toBe(200);
    expect(evaluateRes.status).toBe(200);

    const testEvalBody = (await testEvalRes.json()) as TestEvaluationResponse;
    const evaluateBody = (await evaluateRes.json()) as { variant: boolean };

    expect(testEvalBody).toMatchObject({
      variantName: parityCase.expect.variantName,
      value: parityCase.expect.value,
      reason: { type: parityCase.expect.reasonType },
    });
    expect(evaluateBody).toEqual({ variant: parityCase.expect.value });
    // Public evaluate deliberately flattens reason detail (out of scope for
    // SPL-303); parity here is success + resolved value, not reason wire shape.
    expect(evaluateRes.headers.get("x-variant-name")).toBe(parityCase.expect.variantName);
  });

  it("wire schema rejects null attribute values; absent keys are allowed", () => {
    expect(
      EvaluationContextSchema.safeParse({
        targetingKey: "user-parity",
        idType: "user",
        attributes: { plan: null },
      }).success,
    ).toBe(false);
    expect(
      EvaluationContextSchema.safeParse({
        targetingKey: "user-parity",
        idType: "user",
        attributes: {},
      }).success,
    ).toBe(true);
  });

  it("HTTP evaluate rejects null plan before resolution; absent plan succeeds", async () => {
    const { app } = await makeParityHttpHarness();

    const nullRes = await app.request(
      EVALUATE_PATH,
      sdkRouteInit(
        CLIENT_KEY,
        {},
        {
          targetingKey: "user-parity",
          attributes: { plan: null },
        },
      ),
    );
    const absentRes = await app.request(
      EVALUATE_PATH,
      sdkRouteInit(
        CLIENT_KEY,
        {},
        {
          targetingKey: "user-parity",
          attributes: {},
        },
      ),
    );

    expect(nullRes.status).toBeGreaterThanOrEqual(400);
    const nullBody = (await nullRes.json()) as ErrorResponse;
    expect(nullBody.code).toMatch(/VALIDATION|INVALID|BAD/i);

    expect(absentRes.status).toBe(200);
    await expect(absentRes.json()).resolves.toEqual({ variant: false });
  });
});
