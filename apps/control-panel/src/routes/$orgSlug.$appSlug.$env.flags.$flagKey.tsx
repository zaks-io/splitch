import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import { createFileRoute } from "@tanstack/react-router";
import { FlagDetailPage } from "#components/flags/flag-detail-page";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { scopedHref } from "#lib/shell/app-shell-navigation";
import { loadControlPanelFlagDetail } from "#lib/flags/control-plane-flag-functions";
import { loadControlPanelSettings } from "#lib/settings/control-plane-settings-functions";
import { isFlagDetailNotFound } from "#lib/flags/flag-detail-data";
import { reportRouteError } from "#lib/observability/panel-observability";
import { promotionSources } from "#lib/promotions/promotion-source";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags/$flagKey")({
  loader: async ({ context, params }) => {
    const scoped = context.scoped;
    // flags_get resolves the key inside this App's scope, so a key from another
    // App is simply absent here rather than readable.
    const [result, settings] = await Promise.all([
      loadControlPanelFlagDetail({
        data: {
          appId: scoped.scope.appId,
          env: scoped.scope.env,
          environmentId: scoped.scope.environmentId,
          flagKey: params.flagKey,
        },
      }),
      loadControlPanelSettings({ data: scoped.scope }),
    ]);
    if (!result.ok) throw new Error(result.error.message);
    const sources = promotionSources(scoped.navigation, scoped.scope.appId, scoped.scope.env);
    return {
      detail: result.data,
      clientKey: settings.ok ? settings.data.clientKey.keyMaterial : undefined,
      scope: scoped.scope,
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
  const { clientKey, detail, scope, promotionSourceEnv } = Route.useLoaderData();

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
        clientKey={clientKey}
        environmentId={scope.environmentId}
        promotionSourceEnv={promotionSourceEnv}
        scopeHref={scopedHref(scope)}
        view={detail}
      />
    </PanelPageBody>
  );
}
