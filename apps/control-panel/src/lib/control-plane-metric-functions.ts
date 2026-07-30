import { env as workerEnv } from "cloudflare:workers";
import type { Metric } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type {
  PanelMetricDeleteOutput,
  PanelMetricsListOutput,
} from "@splitch/control-plane-sdk/panel-metrics";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelMetricsClient } from "./control-plane-metrics";
import {
  metricCreateInput,
  MetricDraftSchema,
  metricDraftIssues,
  metricUpdateInput,
} from "./metric-form-model";
import { loadSessionFromRequest } from "./session";

const MetricScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});
const MetricMutationSchema = MetricScopeSchema.extend({
  metricId: z.string().min(1).optional(),
  draft: MetricDraftSchema,
});
const MetricDeleteSchema = MetricScopeSchema.extend({
  metricId: z.string().min(1),
});

export const loadControlPanelMetrics = createServerFn({ method: "GET" })
  .validator((data: unknown) => MetricScopeSchema.safeParse(data))
  .handler(
    async ({ data: parsed }): Promise<ControlPlaneOperationResult<PanelMetricsListOutput>> => {
      if (!parsed.success) return malformed("The Metric scope is malformed");
      const authorized = await authorizedMetricsClient(parsed.data.environmentId);
      if (!authorized.ok) return authorized.result;
      return authorized.metrics.list({ appId: parsed.data.appId });
    },
  );

export const saveControlPanelMetric = createServerFn({ method: "POST" })
  .validator((data: unknown) => MetricMutationSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ControlPlaneOperationResult<Metric>> => {
    if (!parsed.success) return malformed("The Metric draft is malformed");
    const { appId, environmentId, metricId, draft } = parsed.data;
    const issues = metricDraftIssues(draft);
    if (issues.length > 0) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "VALIDATION_ERROR",
          message: "The Metric draft is incomplete",
          details: {
            issues: issues.map((issue) => ({
              path: ["body", issue.path],
              message: issue.message,
            })),
          },
        },
      };
    }
    const authorized = await authorizedMetricsClient(environmentId);
    if (!authorized.ok) return authorized.result;
    return metricId
      ? authorized.metrics.update({ appId, metricId, ...metricUpdateInput(draft) })
      : authorized.metrics.create(metricCreateInput(appId, draft));
  });

export const deleteControlPanelMetric = createServerFn({ method: "POST" })
  .validator((data: unknown) => MetricDeleteSchema.safeParse(data))
  .handler(
    async ({ data: parsed }): Promise<ControlPlaneOperationResult<PanelMetricDeleteOutput>> => {
      if (!parsed.success) return malformed("The Metric delete request is malformed");
      const authorized = await authorizedMetricsClient(parsed.data.environmentId);
      if (!authorized.ok) return authorized.result;
      return authorized.metrics.delete({
        appId: parsed.data.appId,
        metricId: parsed.data.metricId,
      });
    },
  );

async function authorizedMetricsClient(environmentId: string) {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
  if (!loaded.ok) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED" as const, message: "authentication required", details: {} },
      },
    };
  }
  return {
    ok: true as const,
    metrics: createControlPanelMetricsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      environmentId,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}

function malformed<T>(message: string): ControlPlaneOperationResult<T> {
  return {
    ok: false,
    status: 400,
    error: { code: "VALIDATION_ERROR", message, details: { issues: [] } },
  };
}
