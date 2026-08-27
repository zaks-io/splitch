import { boundListRead, LIST_READ_LIMIT } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound } from "./app-environment-model";
import { pathParam } from "./handler-input";
import { type MetricSegmentDeps, metricResponse } from "./metric-segment-shared";

export async function listMetrics(
  deps: MetricSegmentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  const scanned = await deps.repo.experiments.listMetrics(appScope(appId), {
    limit: LIST_READ_LIMIT + 1,
  });
  return Response.json(boundListRead(scanned.map(metricResponse)));
}
