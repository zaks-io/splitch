import type { ControlPanelOperation } from "./control-panel-operation.js";

const METRICS_PATH = /^\/apps\/([^/]+)\/metrics\/?$/;
const METRIC_PATH = /^\/apps\/([^/]+)\/metrics\/([^/]+)\/?$/;

const METRIC_COLLECTION_METHODS = {
  GET: "metrics_list",
  POST: "metrics_create",
} as const;

const METRIC_RESOURCE_METHODS = {
  GET: "metrics_get",
  PATCH: "metrics_update",
  DELETE: "metrics_delete",
} as const;

export function parseMetrics(
  method: string,
  pathname: string,
  environmentValue?: string,
): ControlPanelOperation | null {
  const environmentId = environmentValue ? decodeSegment(environmentValue) : null;
  if (!environmentId) return null;
  return (
    parseMetricCollection(method, pathname, environmentId) ??
    parseMetricResource(method, pathname, environmentId)
  );
}

function parseMetricCollection(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = METRIC_COLLECTION_METHODS[method as keyof typeof METRIC_COLLECTION_METHODS];
  const appId = decodeMatch(pathname.match(METRICS_PATH), 1);
  return id && appId ? { id, appId, environmentId } : null;
}

function parseMetricResource(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = METRIC_RESOURCE_METHODS[method as keyof typeof METRIC_RESOURCE_METHODS];
  const resource = pathname.match(METRIC_PATH);
  const appId = decodeMatch(resource, 1);
  const metricId = decodeMatch(resource, 2);
  return id && appId && metricId ? { id, appId, environmentId, metricId } : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  const value = match?.[index];
  return value ? decodeSegment(value) : null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
