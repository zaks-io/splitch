import { appScope, createRepository } from "@splitch/db";
import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

const APP_ID = "app_existing_metric";
const NOW = "2026-01-01T00:00:00.000Z";

let mf: Miniflare;
let d1: D1Database;
let eventDefinitionStore: KVNamespace;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: { CONFIG_STORE: "event-definitions" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  eventDefinitionStore = (await mf.getKVNamespace("CONFIG_STORE")) as unknown as KVNamespace;
});

afterEach(async () => mf.dispose());

const EVENT_DEFINITION_ID =
  "event_definition_migrated_6170705f6578697374696e675f6d6574726963_70757263686173655f636f6d706c65746564";
describe("the Event Definition migration", () => {
  it("keeps a pre-existing Metric readable through GET /apps/:appId/metrics", async () => {
    await migrateExistingMetric();

    const app = migratedApp();
    const definitionResponse = await app.request(
      `/apps/${APP_ID}/event-definitions/${EVENT_DEFINITION_ID}`,
      { headers: { authorization: "Bearer migration-proof" } },
    );
    expect(definitionResponse.status).toBe(200);
    expect(await definitionResponse.json()).toMatchObject({
      id: EVENT_DEFINITION_ID,
      state: "incomplete",
      currentPublishedVersionId: null,
      versions: [],
    });
    const response = await app.request(`/apps/${APP_ID}/metrics`, {
      headers: { authorization: "Bearer migration-proof" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        expect.objectContaining({
          id: "metric_existing_revenue",
          eventDefinitionId: EVENT_DEFINITION_ID,
          eventFieldName: "amount",
        }),
      ],
    });
  });

  it("leaves a pre-existing Metric editable through PATCH /apps/:appId/metrics/:metricId", async () => {
    await migrateExistingMetric();

    const response = await migratedApp().request(
      `/apps/${APP_ID}/metrics/metric_existing_revenue`,
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer migration-proof",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Purchase revenue (renamed)" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "metric_existing_revenue",
      name: "Purchase revenue (renamed)",
      eventDefinitionId: EVENT_DEFINITION_ID,
      eventFieldName: "amount",
    });
  });

  it("refuses to change the binding while its Event Definition is incomplete", async () => {
    await migrateExistingMetric();

    const response = await migratedApp().request(
      `/apps/${APP_ID}/metrics/metric_existing_revenue`,
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer migration-proof",
          "content-type": "application/json",
        },
        body: JSON.stringify({ eventFieldName: "total" }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["body", "eventDefinitionId"] }] },
    });
  });

  it("publishes Version 1 after the operator supplies the missing complete schema", async () => {
    await migrateExistingMetric();

    const response = await migratedApp().request(
      `/apps/${APP_ID}/event-definitions/${EVENT_DEFINITION_ID}/versions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer migration-proof",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entityType: "user",
          fields: [
            {
              name: "amount",
              type: "number",
              required: false,
              numberKind: "amount",
              minimum: 0,
              maximum: 1_000_000,
            },
          ],
          dimensions: [],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, entityType: "user" });
    const definition = await createRepository(d1).eventDefinitions.get(
      appScope(APP_ID),
      EVENT_DEFINITION_ID,
    );
    expect(definition).toMatchObject({
      state: "published",
      currentPublishedVersionId: expect.any(String),
    });
  });
});

/** Seeds the pre-migration Metric, then applies the Event Definition migration over it. */
async function migrateExistingMetric(): Promise<void> {
  const statements = migrationStatements();
  const eventMigration = statements.findIndex((statement) =>
    statement.startsWith("CREATE TABLE `event_definitions`"),
  );
  expect(eventMigration).toBeGreaterThan(0);

  await applySchema(d1, statements.slice(0, eventMigration));
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO organizations
             (id, name, slug, plan, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("org_existing_metric", "Existing Metric Co", "existing-metric", "free", NOW, NOW),
    d1
      .prepare(
        `INSERT INTO apps
             (id, organization_id, name, key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(APP_ID, "org_existing_metric", "Existing Metric App", "existing-metric", NOW, NOW),
    d1
      .prepare(
        `INSERT INTO app_memberships (app_id, user_id, role, created_at)
           VALUES (?, ?, ?, ?)`,
      )
      .bind(APP_ID, "migration-proof", "owner", NOW),
    d1
      .prepare(
        `INSERT INTO metrics
             (id, app_id, key, name, kind, event_name, event_value_field, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "metric_existing_revenue",
        APP_ID,
        "purchase-revenue",
        "Purchase revenue",
        "revenue",
        "purchase_completed",
        "amount",
        NOW,
      ),
  ]);
  await applySchema(d1, statements.slice(eventMigration));
}

function migratedApp() {
  return createApp({
    authResolver,
    rateLimiter,
    repo: createRepository(d1),
    eventDefinitionStore,
  });
}

const authResolver: AuthResolver = () => ({
  ok: true,
  principal: {
    kind: "control-plane-token",
    id: "migration-proof",
    scopes: [`app:${APP_ID}:owner`],
    orgId: null,
    appId: APP_ID,
    environmentId: null,
    authDoor: "device_flow",
  },
});

const rateLimiter: RateLimiter = () => ({ limited: false });
