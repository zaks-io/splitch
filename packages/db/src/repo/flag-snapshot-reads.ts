import { and, eq, inArray } from "drizzle-orm";
import {
  environments,
  experiments,
  flagConfigs,
  flags,
  targetingRules,
  variants,
} from "../schema/index";
import type { Db } from "./client";
import { scopedFlagConfig, scopedTargetingRule } from "./flag-config-direct-write";
import { variantsInInsertOrder } from "./flag-variant-create";
import { assertMintedScope, type EnvScope } from "./scope";

/** Independent authoring reads share a D1 batch, with the original scope on each statement. */
export function makeFlagSnapshotReads(db: Db) {
  function contextQueries(scope: EnvScope, flagId: string) {
    assertMintedScope(scope);
    const flagPredicate = and(eq(flags.appId, scope.appId), eq(flags.id, flagId));
    return [
      db.select().from(flags).where(flagPredicate).limit(1),
      db.select().from(flagConfigs).where(scopedFlagConfig(scope, flagId)).limit(1),
      variantsInInsertOrder(
        db,
        inArray(variants.flagId, db.select({ id: flags.id }).from(flags).where(flagPredicate)),
      ),
    ] as const;
  }

  return {
    async readFlagConfigReviewContext(scope: EnvScope, configId: string) {
      assertMintedScope(scope);
      const [configs, environmentRows] = await db.batch([
        db
          .select()
          .from(flagConfigs)
          .where(
            and(
              eq(flagConfigs.appId, scope.appId),
              eq(flagConfigs.environmentId, scope.environmentId),
              eq(flagConfigs.id, configId),
            ),
          )
          .limit(1),
        db
          .select()
          .from(environments)
          .where(and(eq(environments.appId, scope.appId), eq(environments.id, scope.environmentId)))
          .limit(1),
      ]);
      return { config: configs[0] ?? null, environment: environmentRows[0] ?? null };
    },

    async readFlagConfigWriteContext(scope: EnvScope, flagId: string) {
      const [flagRows, configRows, variantRows] = await db.batch(contextQueries(scope, flagId));
      const flag = flagRows[0];
      const config = configRows[0];
      return flag && config ? { flag, config, variants: variantRows } : null;
    },

    async readFlagSnapshotInputs(scope: EnvScope, flagId: string) {
      const [flagRows, configRows, variantRows, ruleRows, runningExperiments] = await db.batch([
        ...contextQueries(scope, flagId),
        db.select().from(targetingRules).where(scopedTargetingRule(scope, flagId)),
        db
          .select()
          .from(experiments)
          .where(
            and(
              eq(experiments.appId, scope.appId),
              eq(experiments.environmentId, scope.environmentId),
              eq(experiments.flagId, flagId),
              eq(experiments.status, "running"),
            ),
          ),
      ]);
      if (runningExperiments.length > 1) {
        throw new Error("findRunningExperimentForFlag: multiple running Experiments for one Flag");
      }
      const flag = flagRows[0];
      if (!flag) return null;
      return {
        flag,
        config: configRows[0] ?? null,
        variants: variantRows,
        targetingRules: ruleRows,
        runningExperiment: runningExperiments[0] ?? null,
      };
    },
  };
}
