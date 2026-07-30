import { deriveMcpTools, getRoute } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  createFlag,
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { seedOrgApp } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("control-plane Metric and Segment CRUD", () => {
  it("round-trips every Metric kind and Segment CRUD", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);

    const binomial = await createMetric(appId, jwt, {
      key: "signup",
      kind: "binomial",
      eventName: "signed_up",
    });
    await createMetric(appId, jwt, {
      key: "items-added",
      kind: "count",
      eventName: "cart_item_added",
      eventValueField: "quantity",
    });
    await createMetric(appId, jwt, {
      key: "purchase-revenue",
      kind: "revenue",
      eventName: "purchase_completed",
      eventValueField: "amount",
    });
    const ratio = await createMetric(appId, jwt, {
      key: "signup-rate",
      kind: "ratio",
      eventName: "signed_up",
      denominator: { metricId: binomial.id },
    });

    const metrics = await request(h, "GET", `/apps/${appId}/metrics`, jwt);
    expect(metrics.status).toBe(200);
    expect(
      ((await metrics.json()) as { items: Array<{ kind: string }> }).items
        .map((m) => m.kind)
        .sort(),
    ).toEqual(["binomial", "count", "ratio", "revenue"]);

    const metricPatch = await request(h, "PATCH", `/apps/${appId}/metrics/${binomial.id}`, jwt, {
      name: "Signup completed",
      key: "signup-completed",
    });
    expect(metricPatch.status).toBe(200);
    expect(await metricPatch.json()).toMatchObject({
      id: binomial.id,
      name: "Signup completed",
      key: "signup-completed",
    });

    const segment = await createSegment(appId, jwt);
    const segments = await request(h, "GET", `/apps/${appId}/segments`, jwt);
    expect(segments.status).toBe(200);
    expect(await segments.json()).toMatchObject({ items: [{ id: segment.id, name: "Paid plan" }] });

    const segmentPatch = await request(h, "PATCH", `/apps/${appId}/segments/${segment.id}`, jwt, {
      name: "Enterprise plan",
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
    });
    expect(segmentPatch.status).toBe(200);
    expect(await segmentPatch.json()).toMatchObject({
      id: segment.id,
      name: "Enterprise plan",
      conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
    });

    const deleteSegment = await request(h, "DELETE", `/apps/${appId}/segments/${segment.id}`, jwt);
    expect(deleteSegment.status).toBe(200);
    expect(await deleteSegment.json()).toEqual({ deleted: true });

    const deleteRatio = await request(h, "DELETE", `/apps/${appId}/metrics/${ratio.id}`, jwt);
    expect(deleteRatio.status).toBe(200);
    expect(await deleteRatio.json()).toEqual({ deleted: true });
  });
});

describe("control-plane Metric and Segment invariants", () => {
  it("rejects Metric kind changes and cross-App ratio denominators", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const metric = await createMetric(appId, jwt, {
      key: "signup",
      kind: "binomial",
      eventName: "signed_up",
    });
    await seedOrgApp(h.bindings.d1, {
      orgId: "org_other_metric",
      orgName: "Other Metric Co",
      appId: "app_other_metric",
      appName: "Other Metric App",
      appKey: "other-metric",
    });
    const otherMetric = await createRepository(h.bindings.d1).experiments.metrics.insert(
      appScope("app_other_metric"),
      {
        id: "metric_other_app",
        appId: "app_other_metric",
        key: "visits",
        name: "Visits",
        kind: "binomial",
        eventName: "visited",
        createdAt: NOW_ISO,
      },
    );

    const typeChange = await request(h, "PATCH", `/apps/${appId}/metrics/${metric.id}`, jwt, {
      kind: "count",
      eventValueField: "quantity",
    });
    expect(typeChange.status).toBe(400);
    expect((await errorBody(typeChange)).code).toBe("VALIDATION_ERROR");

    const crossAppRatio = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
      appId,
      name: "Bad ratio",
      key: "bad-ratio",
      kind: "ratio",
      eventName: "signed_up",
      denominator: { metricId: otherMetric.id },
    });
    expect(crossAppRatio.status).toBe(400);
    expect((await errorBody(crossAppRatio)).code).toBe("VALIDATION_ERROR");
  });

  it("blocks decision-locked Metric patch and running Experiment deletes", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const prod = createdApp.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    const metric = await createMetric(appId, jwt, {
      key: "signup",
      kind: "binomial",
      eventName: "signed_up",
    });
    const segment = await createSegment(appId, jwt);
    // A real Flag row: the Experiment's flag_id is a live foreign key, and the
    // old invented id only passed because the Node fixture schema had no FKs.
    const flag = await createFlag(h, appId, jwt);
    await seedRunningExperiment(appId, prod?.id ?? "", metric.id, segment.id, flag.id);

    const patchMetric = await request(h, "PATCH", `/apps/${appId}/metrics/${metric.id}`, jwt, {
      name: "Renamed while running",
    });
    expect(patchMetric.status).toBe(409);
    expect((await errorBody(patchMetric)).code).toBe("DECISION_LOCKED");

    const deleteMetric = await request(h, "DELETE", `/apps/${appId}/metrics/${metric.id}`, jwt);
    expect(deleteMetric.status).toBe(409);
    expect((await errorBody(deleteMetric)).code).toBe("EXPERIMENT_RUNNING");

    const deleteSegment = await request(h, "DELETE", `/apps/${appId}/segments/${segment.id}`, jwt);
    expect(deleteSegment.status).toBe(409);
    expect((await errorBody(deleteSegment)).code).toBe("EXPERIMENT_RUNNING");
  });
});

describe("control-plane Metric and Segment MCP derivation", () => {
  it("derives Metric and Segment MCP tools from the same routes", () => {
    const tools = deriveMcpTools();
    const expected = [
      "metrics_list",
      "metrics_create",
      "metrics_get",
      "metrics_update",
      "metrics_delete",
      "segments_list",
      "segments_create",
      "segments_get",
      "segments_update",
      "segments_delete",
    ] as const;

    for (const operationId of expected) {
      const route = getRoute(operationId);
      const tool = tools.find((candidate) => candidate.name === operationId);
      expect(route).toBeDefined();
      expect(tool).toBeDefined();
      expect(tool?.outputSchema).toBe(route?.output);
    }
  });
});

type MetricBody = {
  key: string;
  kind: string;
  eventName: string;
  eventValueField?: string;
  denominator?: { metricId: string };
};

async function createMetric(appId: string, jwt: string, body: MetricBody) {
  const res = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
    appId,
    name: body.key,
    ...body,
  });
  if (res.status !== 200) {
    throw new Error(`create metric failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { id: string; kind: string; denominator?: { metricId: string } };
}

async function createSegment(appId: string, jwt: string) {
  const res = await request(h, "POST", `/apps/${appId}/segments`, jwt, {
    name: "Paid plan",
    conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
  });
  if (res.status !== 200) {
    throw new Error(`create segment failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

async function seedRunningExperiment(
  appId: string,
  environmentId: string,
  metricId: string,
  segmentId: string,
  flagId: string,
): Promise<void> {
  const repo = createRepository(h.bindings.d1);
  const scope = envScope(appId, environmentId);
  await repo.experiments.experiments.insert(scope, {
    id: "exp_metric_segment_guard",
    appId,
    environmentId,
    key: "metric-segment-guard",
    flagId,
    name: "Metric Segment Guard",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: JSON.stringify([{ metricId }]),
    guardrailMetrics: "[]",
    dimensions: "[]",
    draftSegmentIds: JSON.stringify([segmentId]),
    liveRunId: "run_metric_segment_guard",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.runs.insert(scope, {
    id: "run_metric_segment_guard",
    appId,
    environmentId,
    experimentId: "exp_metric_segment_guard",
    runNumber: 1,
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: "salt_metric_segment_guard",
    allocation: JSON.stringify({ control: 100 }),
    variantSet: JSON.stringify([
      {
        id: "variant_control_metric_segment_guard",
        name: "control",
        value: false,
      },
    ]),
    controlVariantId: "variant_control_metric_segment_guard",
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: JSON.stringify([{ metricId }]),
    guardrailDecisions: "[]",
    configHash: "hash_metric_segment_guard",
    startedAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
}
