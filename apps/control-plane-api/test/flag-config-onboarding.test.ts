import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp as createEvaluationApp } from "../../../apps/evaluation-api/src/app";
import { StaticSaltStore } from "../../../apps/evaluation-api/src/assignment/assignment-store-test-fixtures";
import { makeDataPlaneAuthResolver } from "../../../apps/evaluation-api/src/data-plane-auth";
import { RecordingAssignmentStore } from "../../../apps/evaluation-api/src/evaluate/evaluate-path-test-fixtures";
import { KvProvider } from "../../../apps/evaluation-api/src/provider/kv-provider";
import {
  RecordingEvaluationCommitSink,
  RecordingEvaluationUsageSink,
  RecordingExposureSink,
} from "../../../apps/evaluation-api/src/sdk-route-test-fixtures";
import { createFlag, NOW_ISO, request } from "../src/flag-definition-test-harness";
import {
  type LifecycleHarness,
  lifecycleAppToken,
  lifecycleCreateDefaultApp,
  setup,
} from "./flag-config-lifecycle-harness";

let h: LifecycleHarness;

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => h.bindings.dispose());

describe("flag configuration onboarding path", () => {
  it("supports create → configure dev → verify → evaluate through real API paths", async () => {
    const createdApp = await lifecycleCreateDefaultApp(h);
    const jwt = await lifecycleAppToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const dev = createdApp.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();

    const disabled = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/envs/${dev?.id}/flags/${flag.id}/config`,
      jwt,
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      flagId: flag.id,
      environmentId: dev?.id,
      enabled: false,
      availableVariantNames: [],
      targetingRules: [],
    });

    const configured = await request(
      h,
      "PATCH",
      `/apps/${createdApp.app.id}/envs/${dev?.id}/flags/${flag.id}/config`,
      jwt,
      {
        enabled: true,
        availableVariantNames: ["control"],
        idempotency_key: "idem_onboarding_configure",
      },
    );
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({
      approvalRequest: null,
      config: {
        enabled: true,
        availableVariantNames: ["control"],
        version: 2,
      },
    });

    const clientKeyRes = await request(
      h,
      "GET",
      `/apps/${createdApp.app.id}/envs/${dev?.id}/client-key`,
      jwt,
    );
    expect(clientKeyRes.status).toBe(200);
    const clientKey = (await clientKeyRes.json()) as { keyMaterial: string };

    const evaluationApp = createEvaluationApp({
      authResolver: async () => ({ ok: false, reason: "UNAUTHORIZED" }),
      dataPlaneAuthResolver: makeDataPlaneAuthResolver(h.bindings.credentialKv),
      rateLimiter: () => ({ limited: false }),
      provider: new KvProvider(h.bindings.configKv),
      assignmentStore: new RecordingAssignmentStore(),
      exposureAssembly: {
        saltStore: new StaticSaltStore(),
        sourceId: "lifecycle-test",
        newEventId: () => "evt-lifecycle-1",
        now: () => new Date(Date.parse(NOW_ISO)),
      },
      evaluationCommitSink: new RecordingEvaluationCommitSink(
        new RecordingExposureSink(),
        new RecordingEvaluationUsageSink(),
      ),
      evaluationUsageSink: new RecordingEvaluationUsageSink(),
    });

    const verifyRes = await evaluationApp.request("/api/sdk/verify", {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientKey.keyMaterial}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        flagKey: flag.key,
        targetingKey: "user-lifecycle-1",
        idType: "user",
        attributes: {},
      }),
    });
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toMatchObject({
      variantName: "control",
      value: false,
      reason: "DEFAULT",
    });

    const evaluateRes = await evaluationApp.request("/api/sdk/evaluate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientKey.keyMaterial}`,
        "content-type": "application/json",
        "idempotency-key": "lifecycle-eval-1",
      },
      body: JSON.stringify({
        flagKey: flag.key,
        targetingKey: "user-lifecycle-1",
        idType: "user",
        attributes: {},
      }),
    });
    expect(evaluateRes.status).toBe(200);
    expect(await evaluateRes.json()).toMatchObject({
      variant: false,
    });
  });
});
