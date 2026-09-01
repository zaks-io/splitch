import { and, eq, inArray } from "drizzle-orm";
import { eventDefinitions, eventDefinitionVersions } from "../schema/index";
import type { Db } from "./client";
import { idBatches } from "./id-batches";
import { assertMintedScope, type TenantScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

export function makeEventDefinitionBatchReads(
  db: Db,
  definitions: ScopedTable<typeof eventDefinitions>,
) {
  return {
    async listDefinitionsByIds(scope: TenantScope, ids: readonly string[]) {
      const definitionIds = [...new Set(ids)];
      const pages = await Promise.all(
        idBatches(definitionIds).map((batch) =>
          definitions.findMany(scope, inArray(eventDefinitions.id, batch)),
        ),
      );
      return pages.flat();
    },

    /**
     * Read each Event Definition together with the Version it currently
     * publishes. Start uses this to validate all Metric sources in one D1
     * round trip instead of two serial reads per source Metric.
     */
    async listCurrentPublishedVersions(scope: TenantScope, ids: readonly string[]) {
      assertMintedScope(scope);
      const definitionIds = [...new Set(ids)];
      const pages = await Promise.all(
        idBatches(definitionIds).map((batch) =>
          db
            .select({ definition: eventDefinitions, version: eventDefinitionVersions })
            .from(eventDefinitions)
            .leftJoin(
              eventDefinitionVersions,
              and(
                eq(eventDefinitionVersions.appId, scope.appId),
                eq(eventDefinitionVersions.eventDefinitionId, eventDefinitions.id),
                eq(eventDefinitionVersions.id, eventDefinitions.currentPublishedVersionId),
              ),
            )
            .where(
              and(eq(eventDefinitions.appId, scope.appId), inArray(eventDefinitions.id, batch)),
            ),
        ),
      );
      return pages.flat();
    },
  };
}
