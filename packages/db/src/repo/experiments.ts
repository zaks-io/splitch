import { and, eq } from "drizzle-orm";
import { experiments, metrics, runs } from "../schema/index";
import type { Db } from "./client";
import type { EnvScope, TenantScope } from "./scope";
import { makeEndRun } from "./experiment-end-run";
import { makeStartRun } from "./experiment-start-run";
import { scopedTable } from "./scoped-table";

/**
 * Experiment-domain repository. Per-Environment (require an EnvScope):
 * experiments, runs (ADR-0027). App-scoped: metrics.
 *
 * The `runs` snapshot columns are write-once at Start (ADR-0002/0003); this repo
 * exposes no UPDATE for them. Status/end transitions are the only mutation, and
 * they still route through the scope-bound `update`, so a Run can only be
 * transitioned within its own App+Environment.
 */
export function makeExperimentRepo(db: Db, d1: D1Database) {
  const experimentsTable = scopedTable(db, experiments);
  const runsTable = scopedTable(db, runs);
  const metricsTable = scopedTable(db, metrics);
  const startRun = makeStartRun(d1, experimentsTable, runsTable);
  const endRun = makeEndRun(d1, experimentsTable, runsTable);
  const findRunningExperimentsForFlag = (scope: EnvScope, flagId: string) =>
    experimentsTable.findMany(
      scope,
      and(eq(experiments.flagId, flagId), eq(experiments.status, "running")),
    );

  return {
    experiments: experimentsTable,
    runs: runsTable,
    metrics: metricsTable,

    getExperiment(scope: EnvScope, experimentId: string) {
      return experimentsTable.findOne(scope, eq(experiments.id, experimentId));
    },

    listExperiments(scope: EnvScope) {
      return experimentsTable.findMany(scope);
    },

    updateExperiment(
      scope: EnvScope,
      experimentId: string,
      patch: Partial<
        Pick<
          typeof experiments.$inferInsert,
          | "key"
          | "flagId"
          | "name"
          | "description"
          | "hypothesis"
          | "status"
          | "targetingKeyField"
          | "targetingKeyType"
          | "confidenceLevel"
          | "defaultVariantId"
          | "metrics"
          | "guardrailMetrics"
          | "activationMetricId"
          | "conversionWindowMs"
          | "dimensions"
          | "draftAllocation"
          | "draftSalt"
          | "draftTargetingRules"
          | "draftSegmentIds"
          | "liveRunId"
          | "updatedAt"
          | "updatedBy"
        >
      >,
    ): Promise<typeof experiments.$inferSelect | null> {
      return experimentsTable
        .update(scope, patch, eq(experiments.id, experimentId))
        .then((rows) => rows[0] ?? null);
    },

    removeExperiment(scope: EnvScope, experimentId: string): Promise<number> {
      return experimentsTable.remove(scope, eq(experiments.id, experimentId));
    },

    findRunningExperimentsForFlag,

    async findRunningExperimentForFlag(scope: EnvScope, flagId: string) {
      const rows = await findRunningExperimentsForFlag(scope, flagId);
      if (rows.length > 1) {
        throw new Error("findRunningExperimentForFlag: multiple running Experiments for one Flag");
      }
      return rows[0] ?? null;
    },

    async findRunningExperiment(scope: EnvScope) {
      const rows = await experimentsTable.findMany(scope, eq(experiments.status, "running"));
      return rows[0] ?? null;
    },

    listRunningExperiments(scope: EnvScope) {
      return experimentsTable.findMany(scope, eq(experiments.status, "running"));
    },

    listRunsForExperiment(scope: EnvScope, experimentId: string) {
      return runsTable.findMany(scope, eq(runs.experimentId, experimentId));
    },

    getRun(scope: EnvScope, runId: string) {
      return runsTable.findOne(scope, eq(runs.id, runId));
    },

    updateRunStatus(
      scope: EnvScope,
      runId: string,
      patch: Pick<typeof runs.$inferInsert, "status" | "endedAt"> &
        Partial<Pick<typeof runs.$inferInsert, "endReason">>,
    ): Promise<typeof runs.$inferSelect | null> {
      return runsTable.update(scope, patch, eq(runs.id, runId)).then((rows) => rows[0] ?? null);
    },

    async nextRunNumber(scope: EnvScope, experimentId: string): Promise<number> {
      const existing = await runsTable.findMany(scope, eq(runs.experimentId, experimentId));
      return existing.reduce((max, run) => Math.max(max, run.runNumber), 0) + 1;
    },

    async findRunningRunForExperiment(scope: EnvScope, experimentId: string) {
      const rows = await runsTable.findMany(
        scope,
        and(eq(runs.experimentId, experimentId), eq(runs.status, "running")),
      );
      if (rows.length > 1) {
        throw new Error("findRunningRunForExperiment: multiple running Runs for one Experiment");
      }
      return rows[0] ?? null;
    },

    startRun,
    endRun,

    getMetric(scope: TenantScope, metricId: string) {
      return metricsTable.findOne(scope, eq(metrics.id, metricId));
    },

    updateMetric(
      scope: TenantScope,
      metricId: string,
      patch: Partial<
        Pick<
          typeof metrics.$inferInsert,
          "key" | "name" | "description" | "eventName" | "eventValueField" | "denominatorMetricId"
        >
      >,
    ): Promise<typeof metrics.$inferSelect | null> {
      return metricsTable
        .update(scope, patch, eq(metrics.id, metricId))
        .then((rows) => rows[0] ?? null);
    },

    removeMetric(scope: TenantScope, metricId: string): Promise<number> {
      return metricsTable.remove(scope, eq(metrics.id, metricId));
    },
  };
}
