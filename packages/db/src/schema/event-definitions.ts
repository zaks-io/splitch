import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  (table) => [uniqueIndex("event_definitions_app_name_unique").on(table.appId, table.name)],
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
