import { and, eq, inArray } from "drizzle-orm";
import { experiments, flagConfigs, flags, targetingRules, variants } from "../schema/index";
import type { Db } from "./client";
import { variantsInInsertOrder } from "./flag-variant-create";
import { appScope, type EnvScope } from "./scope";
import { scopedTable } from "./scoped-table";

/** The rows one Environment's Flag Configuration snapshot is built from. */
export interface FlagSnapshotInputs {
  readonly flag: typeof flags.$inferSelect;
  readonly config: typeof flagConfigs.$inferSelect | null;
  readonly variants: (typeof variants.$inferSelect)[];
  readonly targetingRules: (typeof targetingRules.$inferSelect)[];
  readonly runningExperiment: typeof experiments.$inferSelect | null;
}

/**
 * Snapshot reads addressed by Flag key, for the Config Store's cold evaluation
 * path. Resolving the key first and then reading by id costs two sequential D1
 * round trips; here every child read proves the key's Flag through
 * `idsInScope` inside its own statement, so all five run as one round.
 */
export function makeFlagEvaluationReads(db: Db) {
  const flagsTable = scopedTable(db, flags);
  const flagConfigsTable = scopedTable(db, flagConfigs);
  const targetingRulesTable = scopedTable(db, targetingRules);
  const experimentsTable = scopedTable(db, experiments);

  return {
    /**
     * Null when the App has no Flag with this key. "moved" when the statements
     * resolved the key to different Flags, which only a delete and re-create
     * between them can do; the caller re-reads rather than mix two Flags' rows.
     */
    async readFlagSnapshotInputsByKey(
      scope: EnvScope,
      flagKey: string,
    ): Promise<FlagSnapshotInputs | "moved" | null> {
      const app = appScope(scope.appId);
      const flagIds = () => flagsTable.idsInScope(app, eq(flags.key, flagKey));
      const [flag, config, variantRows, ruleRows, runningExperiments] = await Promise.all([
        flagsTable.findOne(app, eq(flags.key, flagKey)),
        flagConfigsTable.findOne(scope, inArray(flagConfigs.flagId, flagIds())),
        variantsInInsertOrder(db, inArray(variants.flagId, flagIds())),
        targetingRulesTable.findMany(scope, inArray(targetingRules.flagId, flagIds())),
        experimentsTable.findMany(
          scope,
          and(inArray(experiments.flagId, flagIds()), eq(experiments.status, "running")),
        ),
      ]);
      if (!flag) return null;
      const children = [config, ...variantRows, ...ruleRows, ...runningExperiments];
      if (children.some((row) => row !== null && row.flagId !== flag.id)) return "moved";
      if (runningExperiments.length > 1) {
        throw new Error("readFlagSnapshotInputsByKey: multiple running Experiments for one Flag");
      }
      return {
        flag,
        config,
        variants: variantRows,
        targetingRules: ruleRows,
        runningExperiment: runningExperiments[0] ?? null,
      };
    },
  };
}
