import { Button } from "@splitch/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { AccessDeniedPage } from "@splitch/ui/state/access-denied-page";
import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { WidgetErrorBoundary } from "#components/widget-error-boundary";
import {
  AccessDeniedError,
  isAccessDeniedError,
  type ScopedLoaderContext,
} from "#lib/loader-context";
import {
  configureControlPanelSentryScope,
  reportExpectedDomainFailure,
  reportRouteError,
} from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";
import { Link, Outlet, createFileRoute, notFound, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env")({
  loader: async ({ location, params }): Promise<ScopedLoaderContext> => {
    const result = await loadScopedSession({ data: params });
    if (result.kind === "unauthenticated") {
      throw loginRedirect(`${location.pathname}${location.search}${location.hash}`);
    }
    if (result.kind === "forbidden") {
      reportExpectedDomainFailure(403, location.pathname, { boundary: "section" });
      throw new AccessDeniedError();
    }
    if (result.kind === "notFound") {
      reportExpectedDomainFailure(404, location.pathname, { boundary: "section" });
      throw notFound();
    }
    configureControlPanelSentryScope(result.context);
    return result.context;
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env");
  },
  errorComponent: ({ error }) => {
    if (isAccessDeniedError(error)) {
      return (
        <AccessDeniedPage
          action={<Button render={<a href="/">Home</a>} variant="outline" />}
          description="You do not have access to this scope."
          title="Access denied"
        />
      );
    }
    return <SectionErrorPage description="Refresh this section or try again later." />;
  },
  notFoundComponent: () => (
    <NotFoundPage description="The requested App or Environment was not found." />
  ),
  pendingComponent: PanelSkeleton,
  component: ScopePlaceholderRoute,
});

function ScopePlaceholderRoute() {
  const context = Route.useLoaderData();

  return (
    <main className="grid gap-6">
      <section className="grid gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">Scope</p>
        <h1 className="font-semibold text-3xl text-foreground">App scope preview</h1>
      </section>

      <nav className="flex flex-wrap gap-2">
        <Link
          className="rounded-md border border-border px-3 py-2 text-sm"
          params={routeParams(context)}
          to="/$orgSlug/$appSlug/$env/flags"
        >
          Flags
        </Link>
        <Link
          className="rounded-md border border-border px-3 py-2 text-sm"
          params={routeParams(context)}
          to="/$orgSlug/$appSlug/$env/experiments"
        >
          Experiments
        </Link>
        <Link
          className="rounded-md border border-border px-3 py-2 text-sm"
          params={routeParams(context)}
          to="/$orgSlug/$appSlug/$env/settings"
        >
          Settings
        </Link>
      </nav>

      <WidgetErrorBoundary route="/$orgSlug/$appSlug/$env">
        <Card>
          <CardHeader>
            <CardTitle>Resolved scope</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-3">
              <ScopeValue label="Organization" value={context.scope.orgSlug} />
              <ScopeValue label="App" value={context.scope.appSlug} />
              <ScopeValue label="Environment" value={context.scope.env} />
              <ScopeValue label="Organization role" value={context.scope.orgRole} />
              <ScopeValue label="App role" value={context.scope.appRole} />
              <ScopeValue label="Environment ID" value={context.scope.environmentId} />
            </dl>
          </CardContent>
        </Card>
      </WidgetErrorBoundary>

      <Outlet />
    </main>
  );
}

function loginRedirect(returnTo: string): ReturnType<typeof redirect> {
  return redirect({
    href: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  });
}

function routeParams(context: ScopedLoaderContext) {
  return {
    appSlug: context.scope.appSlug,
    env: context.scope.env,
    orgSlug: context.scope.orgSlug,
  };
}

function ScopeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="font-medium text-foreground text-sm">{value}</dd>
    </div>
  );
}
