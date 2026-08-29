import type { Registrar } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import type { makeExperimentHandlers } from "./experiment-handlers";
import type { makeMetricSegmentHandlers } from "./metric-segment-handlers";
import { controlPlaneRoute } from "./routes";

export function mountExperimentRoutes(
  app: Hono,
  registrar: Registrar,
  handlers: ReturnType<typeof makeExperimentHandlers>,
): void {
  registrar.mount(app, controlPlaneRoute("experiments_list"), handlers.listExperiments);
  registrar.mount(app, controlPlaneRoute("experiments_create"), handlers.createExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_get"), handlers.getExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_update"), handlers.updateExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_delete"), handlers.deleteExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_start"), handlers.startExperiment);
  registrar.mount(app, controlPlaneRoute("runs_list"), handlers.listRuns);
  registrar.mount(app, controlPlaneRoute("runs_get"), handlers.getRun);
  registrar.mount(app, controlPlaneRoute("runs_end"), handlers.endRun);
}

export function mountMetricRoutes(
  app: Hono,
  registrar: Registrar,
  handlers: ReturnType<typeof makeMetricSegmentHandlers>,
): void {
  registrar.mount(app, controlPlaneRoute("metrics_list"), handlers.listMetrics);
  registrar.mount(app, controlPlaneRoute("metrics_create"), handlers.createMetric);
  registrar.mount(app, controlPlaneRoute("metrics_get"), handlers.getMetric);
  registrar.mount(app, controlPlaneRoute("metrics_update"), handlers.updateMetric);
  registrar.mount(app, controlPlaneRoute("metrics_delete"), handlers.deleteMetric);
}
