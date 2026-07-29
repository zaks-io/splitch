import {
  type CreateMetricRequest,
  MetricSchema,
  type PatchMetricRequest,
} from "@splitch/contracts";
import type { Metric } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

export interface PanelMetricsListInput {
  appId: string;
}

export type PanelMetricCreateInput = CreateMetricRequest;

export interface PanelMetricGetInput {
  appId: string;
  metricId: string;
}

export type PanelMetricUpdateInput = PanelMetricGetInput & PatchMetricRequest;
export type PanelMetricDeleteInput = PanelMetricGetInput;

export interface PanelMetricsListOutput {
  items: Metric[];
}

export interface PanelMetricDeleteOutput {
  deleted: true;
}

export interface PanelMetricsClient {
  list(input: PanelMetricsListInput): Promise<ControlPlaneOperationResult<PanelMetricsListOutput>>;
  create(input: PanelMetricCreateInput): Promise<ControlPlaneOperationResult<Metric>>;
  get(input: PanelMetricGetInput): Promise<ControlPlaneOperationResult<Metric>>;
  update(input: PanelMetricUpdateInput): Promise<ControlPlaneOperationResult<Metric>>;
  delete(
    input: PanelMetricDeleteInput,
  ): Promise<ControlPlaneOperationResult<PanelMetricDeleteOutput>>;
}

export function createPanelMetricsClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelMetricsClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const metricUrl = (appId: string, metricId?: string) =>
    new URL(
      `/apps/${encodeURIComponent(appId)}/metrics${metricId ? `/${encodeURIComponent(metricId)}` : ""}`,
      baseUrl,
    );

  return {
    async list(input) {
      const response = await options.fetch(metricUrl(input.appId));
      return parseControlPlaneResponse(response, "panel_metrics_list", {
        safeParse: parseMetricList,
      });
    },
    async create(input) {
      const response = await options.fetch(metricUrl(input.appId), jsonRequest("POST", input));
      return parseControlPlaneResponse(response, "panel_metrics_create", MetricSchema);
    },
    async get(input) {
      const response = await options.fetch(metricUrl(input.appId, input.metricId));
      return parseControlPlaneResponse(response, "panel_metrics_get", MetricSchema);
    },
    async update(input) {
      const { appId, metricId, ...patch } = input;
      const response = await options.fetch(metricUrl(appId, metricId), jsonRequest("PATCH", patch));
      return parseControlPlaneResponse(response, "panel_metrics_update", MetricSchema);
    },
    async delete(input) {
      const response = await options.fetch(metricUrl(input.appId, input.metricId), {
        method: "DELETE",
      });
      return parseControlPlaneResponse(response, "panel_metrics_delete", {
        safeParse: parseDeleted,
      });
    },
  };
}

function jsonRequest(method: "POST" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseMetricList(
  input: unknown,
): { success: true; data: PanelMetricsListOutput } | { success: false } {
  if (!isObject(input) || !Array.isArray(input.items)) return { success: false as const };
  const items: Metric[] = [];
  for (const item of input.items) {
    const parsed = MetricSchema.safeParse(item);
    if (!parsed.success) return { success: false };
    items.push(parsed.data);
  }
  return { success: true, data: { items } };
}

function parseDeleted(
  input: unknown,
): { success: true; data: PanelMetricDeleteOutput } | { success: false } {
  return isObject(input) && input.deleted === true
    ? { success: true, data: { deleted: true } }
    : { success: false };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
