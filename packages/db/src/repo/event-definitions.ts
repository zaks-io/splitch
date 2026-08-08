import { and, eq } from "drizzle-orm";
import { eventDefinitions, eventDefinitionVersions } from "../schema/index";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope } from "./scope";
import { scopedTable } from "./scoped-table";

export function makeEventDefinitionRepo(db: Db, d1: D1Database) {
  const definitions = scopedTable(db, eventDefinitions);
  const versions = scopedTable(db, eventDefinitionVersions);
  return {
    definitions,
    versions,
    get(scope: TenantScope, id: string) {
      return definitions.findOne(scope, eq(eventDefinitions.id, id));
    },
    findByName(scope: TenantScope, name: string) {
      return definitions.findOne(scope, eq(eventDefinitions.name, name));
    },
    async update(
      scope: TenantScope,
      id: string,
      patch: Partial<
        Pick<
          typeof eventDefinitions.$inferInsert,
          "displayName" | "description" | "updatedAt" | "updatedBy"
        >
      >,
    ) {
      const rows = await definitions.update(scope, patch, eq(eventDefinitions.id, id));
      return rows[0] ?? null;
    },
    listVersions(scope: TenantScope, eventDefinitionId: string) {
      return versions.findMany(
        scope,
        eq(eventDefinitionVersions.eventDefinitionId, eventDefinitionId),
      );
    },
    getVersion(scope: TenantScope, eventDefinitionId: string, id: string) {
      return versions.findOne(
        scope,
        and(
          eq(eventDefinitionVersions.eventDefinitionId, eventDefinitionId),
          eq(eventDefinitionVersions.id, id),
        ),
      );
    },
    async publish(
      scope: TenantScope,
      input: Omit<typeof eventDefinitionVersions.$inferInsert, "version">,
      updatedAt: string,
      updatedBy: string,
    ) {
      assertMintedScope(scope);
      const existing = await versions.findMany(
        scope,
        eq(eventDefinitionVersions.eventDefinitionId, input.eventDefinitionId),
      );
      const version = existing.reduce((max, item) => Math.max(max, item.version), 0) + 1;
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO event_definition_versions
           (id, app_id, event_definition_id, version, schema_hash, entity_type, fields, dimensions, published_at, published_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.id,
            scope.appId,
            input.eventDefinitionId,
            version,
            input.schemaHash,
            input.entityType ?? null,
            input.fields,
            input.dimensions,
            input.publishedAt,
            input.publishedBy ?? null,
          ),
        d1
          .prepare(
            `UPDATE event_definitions
           SET current_published_version_id = ?, updated_at = ?, updated_by = ?
           WHERE app_id = ? AND id = ?`,
          )
          .bind(input.id, updatedAt, updatedBy, scope.appId, input.eventDefinitionId),
      ]);
      return versions.findOne(scope, eq(eventDefinitionVersions.id, input.id));
    },
  };
}
