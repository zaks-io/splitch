import { and, eq, inArray, ne, or } from "drizzle-orm";
import { experiments, runs } from "../schema/index";
import { idBatches, twoAxisIdBatches } from "./id-batches";
import type { EnvScope, TenantScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

export function makeExperimentBatchReads(
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
) {
  return {
    async findExperimentsByReferenceAcrossEnvironments(
      scope: TenantScope,
      environmentIds: readonly string[],
      experimentRef: string,
    ) {
      return readEnvironmentBatches(environmentIds, (batch) =>
        experimentsTable.findManyAcrossEnvironments(
          scope,
          batch,
          and(
            ne(experiments.status, "archived"),
            or(eq(experiments.id, experimentRef), eq(experiments.key, experimentRef)),
          ),
        ),
      );
    },

    async findExperimentsByKeyAcrossEnvironments(
      scope: TenantScope,
      environmentIds: readonly string[],
      experimentKey: string,
    ) {
      return readEnvironmentBatches(environmentIds, (batch) =>
        experimentsTable.findManyAcrossEnvironments(
          scope,
          batch,
          and(ne(experiments.status, "archived"), eq(experiments.key, experimentKey)),
        ),
      );
    },

    async findRunsByIdAcrossEnvironments(
      scope: TenantScope,
      environmentIds: readonly string[],
      runId: string,
    ) {
      return readEnvironmentBatches(environmentIds, (batch) =>
        runsTable.findManyAcrossEnvironments(scope, batch, eq(runs.id, runId)),
      );
    },

    async listExperimentsByIds(scope: EnvScope, experimentIds: readonly string[]) {
      if (experimentIds.length === 0) return [] as (typeof experiments.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(experimentIds).map((batch) =>
          experimentsTable.findMany(
            scope,
            and(inArray(experiments.id, [...batch]), ne(experiments.status, "archived")),
          ),
        ),
      );
      return pages.flat();
    },

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

async function readEnvironmentBatches<T>(
  environmentIds: readonly string[],
  read: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const batch of idBatches(environmentIds)) rows.push(...(await read(batch)));
  return rows;
}
