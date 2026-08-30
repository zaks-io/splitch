import { and, eq, inArray } from "drizzle-orm";
import { experiments, runs } from "../schema/index";
import { idBatches, twoAxisIdBatches } from "./id-batches";
import type { EnvScope, TenantScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

export function makeExperimentBatchReads(
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
) {
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

    async listRunsByIds(scope: EnvScope, runIds: readonly string[]) {
      if (runIds.length === 0) return [] as (typeof runs.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(runIds).map((batch) => runsTable.findMany(scope, inArray(runs.id, [...batch]))),
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
