import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { FlagsPage } from "#components/flags-page";
import { scopedHref } from "#lib/app-shell-navigation";
import { loadControlPanelFlags } from "#lib/control-plane-flag-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { loginRedirect } from "#lib/login-redirect";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags/")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const result = await loadControlPanelFlags({ data: scoped.context.scope });
    if (!result.ok) throw new Error(result.error.message);
    const environments = scoped.context.navigation.orgs
      .find((org) => org.orgId === scoped.context.scope.orgId)
      ?.apps.find((app) => app.appId === scoped.context.scope.appId)?.environments;
    if (!environments) throw new Error("Flags navigation is missing the current App");
    return {
      environments,
      items: result.data.items,
      readLimit: result.data.readLimit,
      readTruncated: result.data.readTruncated,
      scope: scoped.context.scope,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/flags/");
  },
  errorComponent: () => <SectionErrorPage title="Flags unavailable" />,
  pendingComponent: TableSkeleton,
  component: FlagsSectionRoute,
});

function FlagsSectionRoute() {
  const { environments, items, readLimit, readTruncated, scope } = Route.useLoaderData();

  return (
    <FlagsPage
      appId={scope.appId}
      appSlug={scope.appSlug}
      env={scope.env}
      environments={environments}
      environmentId={scope.environmentId}
      items={items}
      readLimit={readLimit}
      readTruncated={readTruncated}
      orgSlug={scope.orgSlug}
      scopeHref={scopedHref(scope)}
    />
  );
}
