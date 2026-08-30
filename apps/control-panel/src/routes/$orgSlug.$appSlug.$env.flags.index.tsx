import { createFileRoute, notFound } from "@tanstack/react-router";
import { FlagsPage } from "#components/flags/flags-page";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { scopedHref } from "#lib/shell/app-shell-navigation";
import { loadControlPanelFlags } from "#lib/flags/control-plane-flag-functions";
import { AccessDeniedError } from "#lib/shared/loader-context";
import { loginRedirect } from "#lib/auth/login-redirect";
import { reportRouteError } from "#lib/observability/panel-observability";
import { loadScopedSession } from "#lib/sessions/session-functions";

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
    const currentEnvironment = environments.find(
      (environment) => environment.env === scoped.context.scope.env,
    );
    if (!currentEnvironment) {
      throw new Error("Flags navigation is missing the current Environment");
    }
    return {
      environments,
      guarded: currentEnvironment.guarded,
      items: result.data.items,
      readLimit: result.data.readLimit,
      readTruncated: result.data.readTruncated,
      scope: scoped.context.scope,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/flags/");
  },
  errorComponent: () => <SectionUnavailable title="Flags unavailable" />,
  pendingComponent: SectionPending,
  component: FlagsSectionRoute,
});

function FlagsSectionRoute() {
  const { environments, guarded, items, readLimit, readTruncated, scope } = Route.useLoaderData();

  return (
    <FlagsPage
      appId={scope.appId}
      appSlug={scope.appSlug}
      env={scope.env}
      environments={environments}
      environmentId={scope.environmentId}
      guarded={guarded}
      items={items}
      readLimit={readLimit}
      readTruncated={readTruncated}
      orgSlug={scope.orgSlug}
      scopeHref={scopedHref(scope)}
    />
  );
}
