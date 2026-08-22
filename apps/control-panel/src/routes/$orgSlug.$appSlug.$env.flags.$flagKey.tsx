import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { FlagDetailPage } from "#components/flag-detail-page";
import { PanelPageBody } from "#components/panel-page-body";
import { SectionPending } from "#components/section-pending";
import { SectionUnavailable } from "#components/section-unavailable";
import { scopedHref } from "#lib/app-shell-navigation";
import { loadControlPanelFlagDetail } from "#lib/control-plane-flag-functions";
import { isFlagDetailNotFound } from "#lib/flag-detail-data";
import { AccessDeniedError } from "#lib/loader-context";
import { loginRedirect } from "#lib/login-redirect";
import { reportRouteError } from "#lib/panel-observability";
import { promotionSources } from "#lib/promotion-source";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags/$flagKey")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    // flags_get resolves the key inside this App's scope, so a key from another
    // App is simply absent here rather than readable.
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
      scope: scoped.context.scope,
      promotionSourceEnv: sources[0]?.env,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/flags/$flagKey");
  },
  errorComponent: () => <SectionUnavailable title="Flag unavailable" />,
  pendingComponent: SectionPending,
  component: FlagDetailRoute,
});

function FlagDetailRoute() {
  const { detail, scope, promotionSourceEnv } = Route.useLoaderData();

  if (isFlagDetailNotFound(detail)) {
    // Keyed flags_get is exact within the App, so a miss is absence — not an
    // artifact of the bounded catalog list page.
    return (
      <PanelPageBody>
        <NotFoundPage
          description="No Flag with this key exists in this App."
          title="Flag not found"
        />
      </PanelPageBody>
    );
  }

  return (
    <PanelPageBody>
      <FlagDetailPage
        appId={scope.appId}
        environmentId={scope.environmentId}
        promotionSourceEnv={promotionSourceEnv}
        scopeHref={scopedHref(scope)}
        view={detail}
      />
    </PanelPageBody>
  );
}
