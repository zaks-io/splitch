import { and, eq, inArray } from "drizzle-orm";
import { experiments } from "../schema/index";
import { idBatches, twoAxisIdBatches } from "./id-batches";
import type { EnvScope, TenantScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

export function makeExperimentBatchReads(experimentsTable: ScopedTable<typeof experiments>) {
  return {
    async listRunningExperimentsForFlags(scope: EnvScope, flagIds: readonly string[]) {
      if (flagIds.length === 0) return [] as (typeof experiments.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(flagIds).map((batch) =>
          experimentsTable.findMany(
            scope,
            and(eq(experiments.status, "running"), inArray(experiments.flagId, [...batch])),
          ),
        ),
      );
      return pages.flat();
    },

    async listRunningExperimentsForFlagsAcrossEnvironments(
      scope: TenantScope,
      flagIds: readonly string[],
      environmentIds: readonly string[],
    ) {
      const pages = await Promise.all(
        twoAxisIdBatches(flagIds, environmentIds).map(({ first, second }) =>
          experimentsTable.findManyAcrossEnvironments(
            scope,
            second,
            and(eq(experiments.status, "running"), inArray(experiments.flagId, first)),
          ),
        ),
      );
      return pages.flat();
    },
  };
}
