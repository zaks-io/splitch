import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt, userRef } from "./columns";
import { apps } from "./identity";

export const eventDefinitions = sqliteTable(
  "event_definitions",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    name: text("name").notNull(),
    family: text("family").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    currentPublishedVersionId: text("current_published_version_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: userRef("created_by"),
    updatedBy: userRef("updated_by"),
  },
  (table) => [
    uniqueIndex("event_definitions_app_name_unique").on(table.appId, table.name),
    // The name is a Telemetry Token everywhere it is read: the hot-config KV key,
    // the ingest contract and the analysis pipes. A row outside that shape has no
    // representation downstream, so the write fails here rather than poisoning the
    // App's Event Definition list at read time.
    check(
      "event_definitions_name_is_telemetry_token",
      sql`length(${table.name}) BETWEEN 1 AND 64
    AND ${table.name} GLOB '[A-Za-z0-9]*'
    AND ${table.name} NOT GLOB '*[^A-Za-z0-9_.:-]*'`,
    ),
  ],
);

export const eventDefinitionVersions = sqliteTable(
  "event_definition_versions",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    eventDefinitionId: text("event_definition_id")
      .notNull()
      .references(() => eventDefinitions.id),
    version: integer("version").notNull(),
    schemaHash: text("schema_hash").notNull(),
    entityType: text("entity_type"),
    fields: text("fields").notNull(),
    dimensions: text("dimensions").notNull(),
    publishedAt: text("published_at").notNull(),
    publishedBy: userRef("published_by"),
  },
  (table) => [
    uniqueIndex("event_definition_versions_number_unique").on(
      table.eventDefinitionId,
      table.version,
    ),
  ],
);
