import { EventDefinitionVersionSchema } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

const APP_ID = "app_existing_metric";
const NOW = "2026-01-01T00:00:00.000Z";

let mf: Miniflare;
let d1: D1Database;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
});

afterEach(async () => mf.dispose());

describe("the Event Definition migration", () => {
  it("keeps a pre-existing Metric readable through GET /apps/:appId/metrics", async () => {
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

    const version = await d1
      .prepare(
        `SELECT id, event_definition_id, version, schema_hash, entity_type,
                fields, dimensions, published_at
         FROM event_definition_versions`,
      )
      .first<{
        id: string;
        event_definition_id: string;
        version: number;
        schema_hash: string;
        entity_type: string | null;
        fields: string;
        dimensions: string;
        published_at: string;
      }>();
    expect(version).not.toBeNull();
    const migratedFields = JSON.parse(version?.fields ?? "null") as Array<Record<string, unknown>>;
    expect(migratedFields[0]).not.toHaveProperty("minimum");
    expect(migratedFields[0]).not.toHaveProperty("maximum");
    expect(() =>
      EventDefinitionVersionSchema.parse({
        id: version?.id,
        eventDefinitionId: version?.event_definition_id,
        version: version?.version,
        schemaHash: version?.schema_hash,
        entityType: version?.entity_type,
        fields: migratedFields,
        dimensions: JSON.parse(version?.dimensions ?? "null"),
        publishedAt: version?.published_at,
      }),
    ).not.toThrow();

    const app = createApp({
      authResolver,
      rateLimiter,
      repo: createRepository(d1),
    });
    const eventDefinitionId =
      "event_definition_migrated_6170705f6578697374696e675f6d6574726963_70757263686173655f636f6d706c65746564";
    const definitionResponse = await app.request(
      `/apps/${APP_ID}/event-definitions/${eventDefinitionId}`,
      { headers: { authorization: "Bearer migration-proof" } },
    );
    expect(definitionResponse.status).toBe(200);
    expect(await definitionResponse.json()).toMatchObject({
      id: eventDefinitionId,
      currentPublishedVersionId: null,
      versions: [
        {
          entityType: null,
          fields: [
            {
              name: "amount",
              type: "number",
              required: false,
              numberKind: "amount",
            },
          ],
        },
      ],
    });
    const response = await app.request(`/apps/${APP_ID}/metrics`, {
      headers: { authorization: "Bearer migration-proof" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        expect.objectContaining({
          id: "metric_existing_revenue",
          eventDefinitionId,
          eventFieldName: "amount",
        }),
      ],
    });
  });
});

const authResolver: AuthResolver = () => ({
  ok: true,
  principal: {
    kind: "control-plane-token",
    id: "migration-proof",
    scopes: [],
    orgId: null,
    appId: APP_ID,
    environmentId: null,
    authDoor: "device_flow",
  },
});

const rateLimiter: RateLimiter = () => ({ limited: false });
