import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { FlagDetailPage } from "#components/flag-detail-page";
import { scopedHref } from "#lib/app-shell-navigation";
import { loadControlPanelFlagDetail } from "#lib/control-plane-flag-functions";
import { isFlagDetailNotFound } from "#lib/flag-detail-data";
import { AccessDeniedError } from "#lib/loader-context";
import { reportRouteError } from "#lib/panel-observability";
import { promotionSources } from "#lib/promotion-source";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags/$flagKey")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    // The Flag key is resolved against the tenant-scoped session's App, so a key
    // from another tenant is simply absent here rather than readable.
    const result = await loadControlPanelFlagDetail({
      data: {
        appId: scoped.context.scope.appId,
        env: scoped.context.scope.env,
        environmentId: scoped.context.scope.environmentId,
        flagKey: params.flagKey,
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    const sources = promotionSources(
      scoped.context.navigation,
      scoped.context.scope.appId,
      scoped.context.scope.env,
    );
    return {
      detail: result.data,
      environmentNames: environmentNames(scoped.context.navigation, scoped.context.scope.appId),
      scope: scoped.context.scope,
      promotionSourceEnv: sources[0]?.env,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/flags/$flagKey");
  },
  errorComponent: () => <SectionErrorPage title="Flag unavailable" />,
  pendingComponent: TableSkeleton,
  component: FlagDetailRoute,
});

function FlagDetailRoute() {
  const { detail, environmentNames, scope, promotionSourceEnv } = Route.useLoaderData();

  if (isFlagDetailNotFound(detail)) {
    // The key is resolved against a bounded catalog read. When that read was
    // truncated, "not in the page" is not "does not exist", and the screen must
    // not state the stronger claim it cannot back (ADR-0036).
    return detail.catalogTruncated ? (
      <NotFoundPage
        description="This App has more Flags than the catalog read returns at once, and this key was not in the page that came back. It may still exist."
        title="Flag not found in this page of the catalog"
      />
    ) : (
      <NotFoundPage
        description="No Flag with this key exists in this App."
        title="Flag not found"
      />
    );
  }

  return (
    <FlagDetailPage
      appId={scope.appId}
      environmentId={scope.environmentId}
      environmentNames={environmentNames}
      promotionSourceEnv={promotionSourceEnv}
      scopeHref={scopedHref(scope)}
      view={detail}
    />
  );
}

function environmentNames(
  navigation: {
    orgs: Array<{
      apps: Array<{
        appId: string;
        environments: readonly { environmentId: string; env: string }[];
      }>;
    }>;
  },
  appId: string,
): Record<string, string> {
  const app = navigation.orgs
    .flatMap((org) => org.apps)
    .find((candidate) => candidate.appId === appId);
  if (!app) throw new Error("App navigation is incomplete");
  return Object.fromEntries(
    app.environments.map((environment) => [environment.environmentId, environment.env]),
  );
}
