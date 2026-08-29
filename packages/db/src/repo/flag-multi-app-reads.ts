import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import {
  apps,
  environments,
  experiments,
  flagConfigs,
  flags,
  organizations,
  targetingRules,
  variants,
} from "../schema/index";
import type { Db } from "./client";
import { idBatches, twoAxisIdBatches } from "./id-batches";
import {
  assertMintedMultiAppScope,
  type MultiAppScope,
  multiAppScope,
  withMultiAppScope,
} from "./scope";

/** Batched cross-App reads. Every statement binds the minted App set. */
export function makeFlagMultiAppReads(db: Db) {
  return {
    async listFlagPageAcrossApps(scope: MultiAppScope, limit: number) {
      assertMintedMultiAppScope(scope);
      if (scope.appIds.length === 0) return [] as (typeof flags.$inferSelect)[];
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("listFlagPageAcrossApps: limit must be a positive integer");
      }
      const pages = await Promise.all(
        idBatches(scope.appIds).map((appIds) =>
          db
            .select()
            .from(flags)
            .where(withMultiAppScope(flags.appId, multiAppScope(appIds)))
            .orderBy(asc(flags.appId), asc(flags.key), asc(flags.id))
            .limit(limit),
        ),
      );
      return pages.flat().sort(compareFlagRows).slice(0, limit);
    },

    async listAppDescriptors(scope: MultiAppScope) {
      assertMintedMultiAppScope(scope);
      if (scope.appIds.length === 0) return [] as AppDescriptor[];
      const pages = await Promise.all(
        idBatches(scope.appIds).map((appIds) =>
          db
            .select({
              orgId: organizations.id,
              orgSlug: organizations.slug,
              appId: apps.id,
              appKey: apps.key,
            })
            .from(apps)
            .innerJoin(organizations, eq(organizations.id, apps.organizationId))
            .where(withMultiAppScope(apps.id, multiAppScope(appIds)))
            .orderBy(asc(apps.id)),
        ),
      );
      return pages.flat().sort((left, right) => binaryCompare(left.appId, right.appId));
    },

    async listEnvironmentsAcrossApps(scope: MultiAppScope) {
      assertMintedMultiAppScope(scope);
      if (scope.appIds.length === 0) return [] as (typeof environments.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(scope.appIds).map((appIds) =>
          db
            .select()
            .from(environments)
            .where(withMultiAppScope(environments.appId, multiAppScope(appIds)))
            .orderBy(asc(environments.appId), asc(environments.createdAt), asc(environments.key)),
        ),
      );
      return pages.flat().sort(compareEnvironmentRows);
    },

    async listVariantsForFlagsAcrossApps(scope: MultiAppScope, flagIds: readonly string[]) {
      assertMintedMultiAppScope(scope);
      const byFlag = new Map<string, (typeof variants.$inferSelect)[]>();
      if (scope.appIds.length === 0 || flagIds.length === 0) return byFlag;
      const pages = await Promise.all(
        twoAxisIdBatches(scope.appIds, flagIds).map(({ first: appIds, second: ids }) =>
          db
            .select(getTableColumns(variants))
            .from(variants)
            .innerJoin(flags, eq(flags.id, variants.flagId))
            .where(
              withMultiAppScope(flags.appId, multiAppScope(appIds), inArray(variants.flagId, ids)),
            )
            .orderBy(asc(variants.flagId), asc(sql`${variants}.rowid`)),
        ),
      );
      for (const row of pages.flat()) {
        const catalog = byFlag.get(row.flagId);
        if (catalog) catalog.push(row);
        else byFlag.set(row.flagId, [row]);
      }
      return byFlag;
    },

    listFlagConfigsAcrossApps(scope: MultiAppScope, flagIds: readonly string[]) {
      return rowsAcrossAppsAndFlags(db, flagConfigs, scope, flagIds);
    },

    listTargetingRulesAcrossApps(scope: MultiAppScope, flagIds: readonly string[]) {
      return rowsAcrossAppsAndFlags(db, targetingRules, scope, flagIds);
    },

    listRunningExperimentsAcrossApps(scope: MultiAppScope, flagIds: readonly string[]) {
      return rowsAcrossAppsAndFlags(
        db,
        experiments,
        scope,
        flagIds,
        eq(experiments.status, "running"),
      );
    },
  };
}

type AppDescriptor = { orgId: string; orgSlug: string; appId: string; appKey: string };

function rowsAcrossAppsAndFlags<
  T extends typeof flagConfigs | typeof targetingRules | typeof experiments,
>(
  db: Db,
  table: T,
  scope: MultiAppScope,
  flagIds: readonly string[],
  extra?: SQL,
): Promise<T["$inferSelect"][]> {
  assertMintedMultiAppScope(scope);
  if (scope.appIds.length === 0 || flagIds.length === 0) return Promise.resolve([]);
  return Promise.all(
    twoAxisIdBatches(scope.appIds, flagIds).map(({ first: appIds, second: ids }) =>
      db
        .select()
        .from(table)
        .where(
          withMultiAppScope(
            table.appId,
            multiAppScope(appIds),
            extra ? and(inArray(table.flagId, ids), extra) : inArray(table.flagId, ids),
          ),
        ),
    ),
  ).then((pages) => pages.flat() as T["$inferSelect"][]);
}

function compareFlagRows(
  left: typeof flags.$inferSelect,
  right: typeof flags.$inferSelect,
): number {
  return (
    binaryCompare(left.appId, right.appId) ||
    binaryCompare(left.key, right.key) ||
    binaryCompare(left.id, right.id)
  );
}

function compareEnvironmentRows(
  left: typeof environments.$inferSelect,
  right: typeof environments.$inferSelect,
): number {
  return (
    binaryCompare(left.appId, right.appId) ||
    binaryCompare(left.createdAt, right.createdAt) ||
    binaryCompare(left.key, right.key)
  );
}

/** Match SQLite's BINARY collation when merging independently sorted batches. */
function binaryCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
