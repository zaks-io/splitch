import { Button } from "@splitch/ui/components/button";
import { AccessDeniedPage } from "@splitch/ui/state/access-denied-page";
import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { LiveUpdatesClient } from "#components/live-updates/live-updates-client";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { PanelShell } from "#components/shell/panel-shell";
import { deferredDestinationAt } from "#lib/shell/app-shell-navigation";
import {
  AccessDeniedError,
  isAccessDeniedError,
  type ScopedLoaderContext,
} from "#lib/shared/loader-context";
import { recordLastVisitedScope } from "#lib/sessions/last-visited-scope-functions";
import { loginRedirect } from "#lib/auth/login-redirect";
import {
  configureControlPanelSentryScope,
  reportExpectedDomainFailure,
  reportRouteError,
} from "#lib/observability/panel-observability";
import { loadScopedSession } from "#lib/sessions/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env")({
  loader: async ({ location, params }): Promise<ScopedLoaderContext> => {
    const result = await loadScopedSession({ data: params });
    if (result.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (result.kind === "forbidden") {
      reportExpectedDomainFailure(403, location.pathname, { boundary: "section" });
      throw new AccessDeniedError();
    }
    if (result.kind === "notFound") {
      reportExpectedDomainFailure(404, location.pathname, { boundary: "section" });
      throw notFound();
    }

    // Hiding a `deferred` destination from the sidebar is a UI decision only
    // (SPL-177); the route still exists. A direct request for one is treated
    // as a 404 rather than rendering implementation-status copy (SPL-253).
    // This is registry-driven so it covers every `deferred` entry, not just
    // Segments, and the Worker's membership/scope refusal above still runs
    // first and unchanged.
    const deferred = deferredDestinationAt(location.pathname, params);
    if (deferred) {
      reportExpectedDomainFailure(404, location.pathname, { boundary: "section" });
      throw notFound({ data: { deferred: true } });
    }

    await recordLastVisitedScope({
      data: {
        orgId: result.context.scope.orgId,
        appSlug: params.appSlug,
        env: params.env,
        path: location.pathname,
      },
    });
    configureControlPanelSentryScope(result.context);
    return result.context;
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env");
  },
  errorComponent: ({ error }) => {
    if (isAccessDeniedError(error)) {
      return (
        <PanelPageBody>
          <AccessDeniedPage
            action={<Button render={<a href="/">Home</a>} variant="outline" />}
            description="You do not have access to this scope."
            title="Access denied"
          />
        </PanelPageBody>
      );
    }
    return (
      <PanelPageBody>
        <SectionErrorPage description="Refresh this section or try again later." />
      </PanelPageBody>
    );
  },
  notFoundComponent: ({ data }) => (
    <PanelPageBody>
      <NotFoundPage
        description={
          (data as { deferred?: boolean } | undefined)?.deferred
            ? "This destination is not available yet."
            : "The requested App or Environment was not found."
        }
      />
    </PanelPageBody>
  ),
  pendingComponent: () => (
    <PanelPageBody>
      <PanelSkeleton />
    </PanelPageBody>
  ),
  component: AppScopeRoute,
});

function AppScopeRoute() {
  const context = Route.useLoaderData();
  const { queryClient } = Route.useRouteContext();
  return (
    <PanelShell
      markers={{
        "data-app-shell": "ready",
        "data-app-id": context.scope.appId,
        "data-environment-id": context.scope.environmentId,
      }}
      rootKey={`${context.scope.appId}:${context.scope.environmentId}`}
      sidebar={{
        navigation: context.navigation,
        org: { orgId: context.scope.orgId, orgSlug: context.scope.orgSlug },
        app: {
          appId: context.scope.appId,
          appSlug: context.scope.appSlug,
          env: context.scope.env,
        },
        userId: context.session.userId,
      }}
    >
      <LiveUpdatesClient queryClient={queryClient} scope={context.scope} />
      <Outlet />
    </PanelShell>
  );
}
