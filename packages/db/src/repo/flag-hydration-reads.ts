import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  environments,
  experiments,
  flagConfigs,
  flags,
  targetingRules,
  variants,
} from "../schema/index";
import type { Db } from "./client";
import { variantsInInsertOrder } from "./flag-variant-create";
import { assertMintedScope, type TenantScope } from "./scope";
import { scopedTable } from "./scoped-table";

export function makeFlagHydrationReads(db: Db) {
  const flagsTable = scopedTable(db, flags);
  return {
    getFlag(scope: TenantScope, flagId: string) {
      return flagsTable.findOne(scope, eq(flags.id, flagId));
    },
    async readFlagHydrationInputs(
      scope: TenantScope,
      flagId: string,
      environmentIds?: readonly string[],
    ) {
      assertMintedScope(scope);
      // One JSON parameter preserves the caller's full Environment set without
      // crossing D1's parameter ceiling or widening child reads to other Environments.
      const selectedEnvironments = db
        .select({ id: environments.id })
        .from(environments)
        .where(
          and(
            eq(environments.appId, scope.appId),
            environmentIds === undefined
              ? undefined
              : sql`${environments.id} in (select value from json_each(${JSON.stringify(environmentIds)}))`,
          ),
        );
      const [flagRows, variantRows, environmentRows, configs, rules, runningExperiments] =
        await db.batch([
          db
            .select()
            .from(flags)
            .where(and(eq(flags.appId, scope.appId), eq(flags.id, flagId)))
            .limit(1),
          variantsInInsertOrder(
            db,
            inArray(
              variants.flagId,
              db
                .select({ id: flags.id })
                .from(flags)
                .where(and(eq(flags.appId, scope.appId), eq(flags.id, flagId))),
            ),
          ),
          db
            .select()
            .from(environments)
            .where(
              and(
                eq(environments.appId, scope.appId),
                inArray(environments.id, selectedEnvironments),
              ),
            )
            .orderBy(asc(environments.createdAt), asc(environments.key)),
          db
            .select()
            .from(flagConfigs)
            .where(
              and(
                eq(flagConfigs.appId, scope.appId),
                eq(flagConfigs.flagId, flagId),
                inArray(flagConfigs.environmentId, selectedEnvironments),
              ),
            ),
          db
            .select()
            .from(targetingRules)
            .where(
              and(
                eq(targetingRules.appId, scope.appId),
                eq(targetingRules.flagId, flagId),
                inArray(targetingRules.environmentId, selectedEnvironments),
              ),
            ),
          db
            .select()
            .from(experiments)
            .where(
              and(
                eq(experiments.appId, scope.appId),
                eq(experiments.flagId, flagId),
                eq(experiments.status, "running"),
                inArray(experiments.environmentId, selectedEnvironments),
              ),
            ),
        ]);
      const flag = flagRows[0];
      return flag
        ? {
            flag,
            variants: variantRows,
            environments: environmentRows,
            configs,
            targetingRules: rules,
            experiments: runningExperiments,
          }
        : null;
    },
  };
}
