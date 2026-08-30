import { createFileRoute, notFound } from "@tanstack/react-router";
import { MetricsPage } from "#components/metrics/metrics-page";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { loadControlPanelMetrics } from "#lib/metrics/control-plane-metric-functions";
import { loadControlPanelSettings } from "#lib/settings/control-plane-settings-functions";
import { AccessDeniedError } from "#lib/shared/loader-context";
import { loginRedirect } from "#lib/auth/login-redirect";
import { reportRouteError } from "#lib/observability/panel-observability";
import { loadScopedSession } from "#lib/sessions/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/metrics")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const [result, settings] = await Promise.all([
      loadControlPanelMetrics({ data: scoped.context.scope }),
      loadControlPanelSettings({ data: scoped.context.scope }),
    ]);
    if (!result.ok) throw new Error(result.error.message);
    return {
      metrics: result.data.items,
      eventDefinitions: result.data.eventDefinitions,
      clientKey: settings.ok ? settings.data.clientKey.keyMaterial : undefined,
      readLimit: result.data.readLimit,
      readTruncated: result.data.readTruncated,
      scope: scoped.context.scope,
    };
  },
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
