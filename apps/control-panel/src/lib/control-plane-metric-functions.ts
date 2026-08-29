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
import { createControlPanelEventDefinitionsClient } from "./control-plane-apps";
import { createControlPanelMetricsClient } from "./control-plane-metrics";
import {
  MetricDraftSchema,
  metricCreateInput,
  metricDraftIssues,
  metricUpdateInput,
} from "./metric-form-model";
import { loadSessionFromRequest } from "./session-refresh";

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
    async ({
      data: parsed,
    }): Promise<
      ControlPlaneOperationResult<
        PanelMetricsListOutput & { eventDefinitions: Array<{ id: string; name: string }> }
      >
    > => {
      if (!parsed.success) return malformed("The Metric scope is malformed");
      const authorized = await authorizedMetricsClient(parsed.data.environmentId);
      if (!authorized.ok) return authorized.result;
      const result = await authorized.metrics.list({ appId: parsed.data.appId });
      if (!result.ok) return result;
      const eventDefinitionIds = [
        ...new Set(result.data.items.flatMap(({ eventDefinitionId }) => eventDefinitionId ?? [])),
      ];
      const definitions = await Promise.all(
        eventDefinitionIds.map((eventDefinitionId) =>
          authorized.eventDefinitions.get({
            appId: parsed.data.appId,
            eventDefinitionId,
          }),
        ),
      );
      const failed = definitions.find((definition) => !definition.ok);
      if (failed && !failed.ok) return failed;
      return {
        ...result,
        data: {
          ...result.data,
          eventDefinitions: definitions.map((definition) => {
            if (!definition.ok) throw new Error("unreachable Event Definition result");
            return { id: definition.data.id, name: definition.data.name };
          }),
        },
      };
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
  const loaded = await loadSessionFromRequest(bindings, getRequest());
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
    eventDefinitions: createControlPanelEventDefinitionsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      environmentId,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
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
