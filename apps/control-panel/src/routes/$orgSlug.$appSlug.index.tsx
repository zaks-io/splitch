import { Button } from "@splitch/ui/components/button";
import { AccessDeniedPage } from "@splitch/ui/state/access-denied-page";
import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { FlagsMatrixPage } from "#components/flags/flags-matrix-page";
import { PanelShell } from "#components/shell/panel-shell";
import { loadControlPanelFlagsMatrix } from "#lib/flags/control-plane-flag-functions";
import { AccessDeniedError, isAccessDeniedError } from "#lib/shared/loader-context";
import {
  configureControlPanelSentryScope,
  reportExpectedDomainFailure,
  reportRouteError,
} from "#lib/observability/panel-observability";
import { loadAppScopedSession } from "#lib/sessions/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/")({
  validateSearch: z.object({ created: z.string().optional() }).strict(),
  loader: async ({ location, params }) => {
    const result = await loadAppScopedSession({
      data: { ...params, visitPath: location.pathname },
    });
    if (result.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
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
    const matrix = await loadControlPanelFlagsMatrix({
      data: {
        appId: result.context.scope.appId,
        environmentIds: result.context.scope.environments.map(
          (environment) => environment.environmentId,
        ),
      },
    });
    if (!matrix.ok) throw new Error(matrix.error.message);
    return {
      scope: result.context.scope,
      session: result.context.session,
      navigation: result.context.navigation,
      matrix: matrix.data,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/");
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
    return <SectionErrorPage title="Flags unavailable" />;
  },
  notFoundComponent: () => (
    <NotFoundPage description="The requested App or Environment was not found." />
  ),
  pendingComponent: TableSkeleton,
  component: AppHomeRoute,
});

function AppHomeRoute() {
  const { matrix, navigation, scope, session } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <PanelShell
      markers={{ "data-app-shell": "ready", "data-app-id": scope.appId }}
      rootKey={scope.appId}
      sidebar={{
        navigation,
        org: { orgId: scope.orgId, orgSlug: scope.orgSlug },
        app: { appId: scope.appId, appSlug: scope.appSlug },
        userId: session.userId,
      }}
    >
      <FlagsMatrixPage
        appId={scope.appId}
        appSlug={scope.appSlug}
        createdKey={search.created}
        environments={scope.environments}
        matrix={matrix}
        orgSlug={scope.orgSlug}
      />
    </PanelShell>
  );
}
