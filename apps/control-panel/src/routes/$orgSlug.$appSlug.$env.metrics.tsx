import { createFileRoute } from "@tanstack/react-router";
import { MetricsPage } from "#components/metrics/metrics-page";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { loadControlPanelMetrics } from "#lib/metrics/control-plane-metric-functions";
import { reportRouteError } from "#lib/observability/panel-observability";
import { loadControlPanelSettings } from "#lib/settings/control-plane-settings-functions";
import { documentTitle } from "#lib/shell/document-title";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/metrics")({
  loader: async ({ context }) => {
    const scoped = context.scoped;
    const [result, settings] = await Promise.all([
      loadControlPanelMetrics({ data: scoped.scope }),
      loadControlPanelSettings({ data: scoped.scope }),
    ]);
    if (!result.ok) throw new Error(result.error.message);
    return {
      metrics: result.data.items,
      eventDefinitions: result.data.eventDefinitions,
      clientKey: settings.ok ? settings.data.clientKey.keyMaterial : undefined,
      readLimit: result.data.readLimit,
      readTruncated: result.data.readTruncated,
      scope: scoped.scope,
    };
  },
  head: ({ params }) => ({
    meta: [{ title: documentTitle("Metrics", params.appSlug, params.env) }],
  }),
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/metrics");
  },
  errorComponent: () => <SectionUnavailable title="Metrics unavailable" />,
  pendingComponent: SectionPending,
  component: MetricsSectionRoute,
});

function MetricsSectionRoute() {
  const { clientKey, eventDefinitions, metrics, readLimit, readTruncated, scope } =
    Route.useLoaderData();
  return (
    <PanelPageBody>
      <MetricsPage
        appId={scope.appId}
        clientKey={clientKey}
        environment={scope.env}
        environmentId={scope.environmentId}
        eventDefinitions={eventDefinitions}
        metrics={metrics}
        readLimit={readLimit}
        readTruncated={readTruncated}
      />
    </PanelPageBody>
  );
}
