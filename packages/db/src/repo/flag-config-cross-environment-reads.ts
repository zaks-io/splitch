import { inArray } from "drizzle-orm";
import { flagConfigs, targetingRules } from "../schema/index";
import { twoAxisIdBatches } from "./id-batches";
import type { TenantScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

/** App-scoped reads over an explicit Environment set for hydrated Flag reads. */
export function makeFlagConfigCrossEnvironmentReads(
  flagConfigsTable: ScopedTable<typeof flagConfigs>,
  targetingRulesTable: ScopedTable<typeof targetingRules>,
) {
  return {
    async listFlagConfigsByFlagIdsAcrossEnvironments(
      scope: TenantScope,
      flagIds: readonly string[],
      environmentIds: readonly string[],
    ) {
      const pages = await Promise.all(
        twoAxisIdBatches(flagIds, environmentIds).map(({ first, second }) =>
          flagConfigsTable.findManyAcrossEnvironments(
            scope,
            second,
            inArray(flagConfigs.flagId, first),
          ),
        ),
      );
      return pages.flat();
    },

    async listTargetingRulesByFlagIdsAcrossEnvironments(
      scope: TenantScope,
      flagIds: readonly string[],
      environmentIds: readonly string[],
    ) {
      const pages = await Promise.all(
        twoAxisIdBatches(flagIds, environmentIds).map(({ first, second }) =>
          targetingRulesTable.findManyAcrossEnvironments(
            scope,
            second,
            inArray(targetingRules.flagId, first),
          ),
        ),
      );
      return pages.flat();
    },
  };
}
