import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MetricsPage } from "#components/metrics-page";
import { loadControlPanelMetrics } from "#lib/control-plane-metric-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { loginRedirect } from "#lib/login-redirect";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/metrics")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const result = await loadControlPanelMetrics({ data: scoped.context.scope });
    if (!result.ok) throw new Error(result.error.message);
    return { metrics: result.data.items, scope: scoped.context.scope };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/metrics");
  },
  errorComponent: () => <SectionErrorPage title="Metrics unavailable" />,
  pendingComponent: TableSkeleton,
  component: MetricsSectionRoute,
});

function MetricsSectionRoute() {
  const { metrics, scope } = Route.useLoaderData();
  return <MetricsPage appId={scope.appId} environmentId={scope.environmentId} metrics={metrics} />;
}
