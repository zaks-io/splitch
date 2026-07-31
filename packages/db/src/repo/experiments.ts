import { and, eq, isNull } from "drizzle-orm";
import { experiments, metrics, runs } from "../schema/index";
import type { Db } from "./client";
import { makeEndRun } from "./experiment-end-run";
import { makeStartRun } from "./experiment-start-run";
import type { EnvScope, TenantScope } from "./scope";
import { type ReadOptions, scopedTable } from "./scoped-table";

const RUN_STATUS_UPDATE_KEYS = new Set(["status", "endedAt", "endReason"]);

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
  const runsWithoutUpdate = {
    findMany: runsTable.findMany,
    findOne: runsTable.findOne,
    insert: runsTable.insert,
    remove: runsTable.remove,
  };
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
    // Run snapshots are insert-once. Lifecycle transitions use the narrow
    // methods below; callers cannot reach a generic snapshot UPDATE path.
    runs: runsWithoutUpdate,
    metrics: metricsTable,

    getExperiment(scope: EnvScope, experimentId: string) {
      return experimentsTable.findOne(scope, eq(experiments.id, experimentId));
    },

    listExperiments(scope: EnvScope) {
      return experimentsTable.findMany(scope);
    },

    /**
     * Compare-and-set on `liveRunId`, the same token `startRun` and `endRun`
     * guard on. A caller reads the Experiment, decides which fields it may
     * write against the Run that read showed, and then passes that Run id back
     * here; the UPDATE matches no row if a Run started or ended in between.
     *
     * Without it a PATCH decided while the Experiment was a draft could land on
     * a row that a Run has since frozen, re-bucketing a live sample. ADR-0002
     * makes that impossible by construction, and this is the write-path half of
     * "by construction".
     * `expectedLiveRunId` is required, not optional, so no caller can skip the
     * check by forgetting it. A `null` result means either "no such Experiment"
     * or "lost the race" — the caller re-reads to tell them apart.
     */
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
          | "owner"
          | "tags"
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
      expectedLiveRunId: string | null,
    ): Promise<typeof experiments.$inferSelect | null> {
      return experimentsTable
        .update(scope, patch, and(eq(experiments.id, experimentId), liveRunIdIs(expectedLiveRunId)))
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

    /**
     * Running Experiments in this Environment, optionally bounded.
     *
     * A caller enforcing a fan-out budget passes `limit: budget + 1`: the extra
     * row proves the budget is blown, and proves it WITHOUT materializing the
     * rows the budget exists to refuse. Checking `rows.length` after an unbounded
     * read pays the exact cost it then declines to pay.
     *
     * No `orderBy` is required here and none is imposed: a bounded page is only
     * ever counted and thrown away, because both budgets refuse whole rather than
     * truncating (a truncated attention list renders as "nothing to do"). Any
     * future caller that KEEPS a bounded page owes a total order — see
     * `ReadOptions`.
     */
    listRunningExperiments(scope: EnvScope, options?: ReadOptions) {
      return experimentsTable.findMany(scope, eq(experiments.status, "running"), options);
    },

    /**
     * The true count of running Experiments in this Environment, via `COUNT`
     * rather than materializing rows. A caller that bounds `listRunningExperiments`
     * for its own read budget still owes a total that is not that bound: reporting
     * a bounded page size as if it were the total renders a floor as a total
     * (ADR-0036).
     */
    countRunningExperiments(scope: EnvScope) {
      return experimentsTable.countRows(scope, eq(experiments.status, "running"));
    },

    listRunsForExperiment(scope: EnvScope, experimentId: string) {
      return runsTable.findMany(scope, eq(runs.experimentId, experimentId));
    },

    countRunsForExperiment(scope: EnvScope, experimentId: string): Promise<number> {
      return runsTable.countRows(scope, eq(runs.experimentId, experimentId));
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
      assertRunStatusUpdate(patch);
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

function liveRunIdIs(expected: string | null) {
  return expected === null ? isNull(experiments.liveRunId) : eq(experiments.liveRunId, expected);
}

function assertRunStatusUpdate(patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) {
    if (!RUN_STATUS_UPDATE_KEYS.has(key)) {
      throw new Error(`updateRunStatus: cannot update immutable Run snapshot field "${key}"`);
    }
  }
}
