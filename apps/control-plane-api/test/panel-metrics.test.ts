import { env } from "cloudflare:workers";
import type { MetricKind } from "@splitch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker, { type SignedControlPanelEntrypoint } from "../src/index.js";
import {
  panelEntrypoint,
  panelFlagsIds,
  panelTestEnv,
  seedAppMembership,
  seedMetricEventDefinition,
  seedPanelFlags,
  signedPanelRequest,
  testCtx,
} from "./panel-flags-harness.js";

const ids = panelFlagsIds("metrics");
const { appId: APP_ID, envId: ENV_ID, otherEnvId: OTHER_ENV_ID, userId: USER_ID } = ids;
let testEnv: ControlPlaneApiEnv;
let entrypoint: SignedControlPanelEntrypoint;

beforeAll(async () => {
  await seedPanelFlags(ids);
  testEnv = panelTestEnv();
  entrypoint = panelEntrypoint(testEnv);
});

describe("SignedControlPanelEntrypoint Metric operations", () => {
  it("round-trips CRUD for all four Metric types", async () => {
    const binomial = await createMetric({
      key: "signup",
      name: "Signup",
      kind: "binomial",
      eventDefinitionId: "signed_up",
    });
    const count = await createMetric({
      key: "items-added",
      name: "Items added",
      kind: "count",
      eventDefinitionId: "cart_item_added",
      eventFieldName: "quantity",
    });
    const revenue = await createMetric({
      key: "purchase-revenue",
      name: "Purchase revenue",
      kind: "revenue",
      eventDefinitionId: "purchase_completed",
      eventFieldName: "amount",
    });
    const ratio = await createMetric({
      key: "signup-rate",
      name: "Signup rate",
      kind: "ratio",
      eventDefinitionId: "signed_up",
      denominator: { metricId: binomial.id },
    });
    const created = [binomial, count, revenue, ratio];

    const list = await panelRequest("GET", `/apps/${APP_ID}/metrics`);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { items: Array<{ kind: MetricKind }> }).items
        .filter((metric) => created.some(({ id }) => id === metric.id))
        .map(({ kind }) => kind)
        .sort(),
    ).toEqual(["binomial", "count", "ratio", "revenue"]);

    for (const metric of created) {
      const updated = await panelRequest("PATCH", `/apps/${APP_ID}/metrics/${metric.id}`, {
        name: `${metric.name} edited`,
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        id: metric.id,
        kind: metric.kind,
        name: `${metric.name} edited`,
      });

      const read = await panelRequest("GET", `/apps/${APP_ID}/metrics/${metric.id}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        id: metric.id,
        kind: metric.kind,
        name: `${metric.name} edited`,
      });
    }

    for (const metric of [ratio, revenue, count, binomial]) {
      const deleted = await panelRequest("DELETE", `/apps/${APP_ID}/metrics/${metric.id}`);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
    }
  });

  it("rechecks live Organization/App membership and Environment ownership", async () => {
    await env.DB.prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(APP_ID, USER_ID)
      .run();
    expect((await panelRequest("GET", `/apps/${APP_ID}/metrics`)).status).toBe(403);
    await seedAppMembership(ids);

    await env.DB.prepare("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?")
      .bind(ids.orgId, USER_ID)
      .run();
    expect((await panelRequest("GET", `/apps/${APP_ID}/metrics`)).status).toBe(403);
    await env.DB.prepare(
      "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)",
    )
      .bind(ids.orgId, USER_ID, "owner", "2026-07-19T00:00:00.000Z")
      .run();

    const crossAppIds = { ...ids, envId: OTHER_ENV_ID };
    const crossApp = await entrypoint.fetch(
      await signedPanelRequest(crossAppIds, "GET", `/apps/${APP_ID}/metrics`),
    );
    expect(crossApp.status).toBe(403);
    expect(await crossApp.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps Metric delegations off public HTTP and binds them to the exact resource", async () => {
    const eventDefinitionId = await seedMetricEventDefinition(ids, "resource_bound");
    const createBody = {
      appId: APP_ID,
      key: "resource-bound",
      name: "Resource bound",
      kind: "binomial",
      eventDefinitionId,
    };
    const request = await signedPanelRequest(ids, "POST", `/apps/${APP_ID}/metrics`, createBody);
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-splitch-panel-session")).toBeNull();

    const publicResponse = await worker.fetch(request.clone(), testEnv, testCtx);
    expect(publicResponse.status).toBe(401);

    const created = await entrypoint.fetch(request);
    expect(created.status).toBe(200);
    const metric = (await created.json()) as { id: string };
    const wrongResource = await signedPanelRequest(
      ids,
      "GET",
      `/apps/${APP_ID}/metrics/${metric.id}`,
      undefined,
      {
        id: "metrics_get",
        appId: APP_ID,
        environmentId: ENV_ID,
        metricId: "metric_other",
      },
    );
    expect((await entrypoint.fetch(wrongResource)).status).toBe(401);
  });
});

type MetricCreateBody = {
  key: string;
  name: string;
  kind: MetricKind;
  eventDefinitionId: string;
  eventFieldName?: string;
  denominator?: { metricId: string };
};

async function createMetric(body: MetricCreateBody) {
  const eventDefinitionId = await seedMetricEventDefinition(
    ids,
    body.eventDefinitionId,
    body.eventFieldName,
  );
  const response = await panelRequest("POST", `/apps/${APP_ID}/metrics`, {
    appId: APP_ID,
    ...body,
    eventDefinitionId,
  });
  if (!response.ok) throw new Error(`Metric create failed: ${await response.text()}`);
  return (await response.json()) as {
    id: string;
    name: string;
    kind: MetricKind;
  };
}

function panelRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return signedPanelRequest(ids, method, path, body).then((request) => entrypoint.fetch(request));
}
