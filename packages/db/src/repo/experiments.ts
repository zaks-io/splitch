import { eq } from "drizzle-orm";
import { experiments, metrics, runs } from "../schema/index.js";
import type { Db } from "./client.js";
import type { EnvScope, TenantScope } from "./scope.js";
import { scopedTable } from "./scoped-table.js";

/**
 * Experiment-domain repository. Per-Environment (require an EnvScope):
 * experiments, runs (ADR-0027). App-scoped: metrics.
 *
 * The `runs` snapshot columns are write-once at Start (ADR-0002/0003); this repo
 * exposes no UPDATE for them. Status/end transitions are the only mutation, and
 * they still route through the scope-bound `update`, so a Run can only be
 * transitioned within its own App+Environment.
 */
export function makeExperimentRepo(db: Db) {
  const experimentsTable = scopedTable(db, experiments);
  const runsTable = scopedTable(db, runs);
  const metricsTable = scopedTable(db, metrics);

  return {
    experiments: experimentsTable,
    runs: runsTable,
    metrics: metricsTable,

    getExperiment(scope: EnvScope, experimentId: string) {
      return experimentsTable.findOne(scope, eq(experiments.id, experimentId));
    },

    listRunsForExperiment(scope: EnvScope, experimentId: string) {
      return runsTable.findMany(scope, eq(runs.experimentId, experimentId));
    },

    getRun(scope: EnvScope, runId: string) {
      return runsTable.findOne(scope, eq(runs.id, runId));
    },

    getMetric(scope: TenantScope, metricId: string) {
      return metricsTable.findOne(scope, eq(metrics.id, metricId));
    },
  };
}
