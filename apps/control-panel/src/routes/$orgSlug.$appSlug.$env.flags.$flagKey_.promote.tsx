import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { PromotionPage } from "#components/promotion-page";
import { scopedHref } from "#lib/app-shell-navigation";
import { loadControlPanelFlagDetail } from "#lib/control-plane-flag-functions";
import { isFlagDetailNotFound } from "#lib/flag-detail-data";
import type { FlagDetailView } from "#lib/flag-detail-view";
import { AccessDeniedError } from "#lib/loader-context";
import { reportRouteError } from "#lib/panel-observability";
import {
  type PromotionSourceOption,
  promotionSources,
  resolvePromotionSource,
} from "#lib/promotion-source";
import { loadScopedSession } from "#lib/session-functions";

type PromotionLoaded = {
  kind: "ready";
  source: FlagDetailView;
  target: FlagDetailView;
  sourceEnvironmentId: string;
  sourceOptions: readonly PromotionSourceOption[];
  appId: string;
  environmentId: string;
  scopeHref: string;
};

type PromotionBlocked = {
  kind: "no-sources" | "unknown-source" | "unconfigured-source" | "unconfigured-target";
  env: string;
  requested?: string;
  scopeHref: string;
  flagKey: string;
};

async function readFlagDetail(
  appId: string,
  env: string,
  environmentId: string,
  flagKey: string,
): Promise<FlagDetailView> {
  const result = await loadControlPanelFlagDetail({ data: { appId, env, environmentId, flagKey } });
  if (!result.ok) throw new Error(result.error.message);
  if (isFlagDetailNotFound(result.data)) throw notFound();
  return result.data;
}

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/flags/$flagKey_/promote")({
  validateSearch: (search: Record<string, unknown>) => ({
    from: typeof search.from === "string" && search.from.length > 0 ? search.from : undefined,
  }),
  loaderDeps: ({ search }) => ({ from: search.from }),
  loader: async ({ deps, location, params }): Promise<PromotionLoaded | PromotionBlocked> => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    const scope = scoped.context.scope;
    const base = { scopeHref: scopedHref(scope), flagKey: params.flagKey, env: scope.env };
    const sources = promotionSources(scoped.context.navigation, scope.appId, scope.env);
    if (sources.length === 0) return { kind: "no-sources", ...base };

    const source = resolvePromotionSource(sources, deps.from);
    if (!source) return { kind: "unknown-source", requested: deps.from, ...base };

    const [target, sourceDetail] = await Promise.all([
      readFlagDetail(scope.appId, scope.env, scope.environmentId, params.flagKey),
      readFlagDetail(scope.appId, source.env, source.environmentId, params.flagKey),
    ]);

    // A Promotion writes the target's Configuration and reads the source's. The
    // Worker answers a missing one with FLAG_NOT_FOUND, so saying which side is
    // missing here is the difference between an actionable screen and a 404.
    if (!sourceDetail.configured) {
      return { kind: "unconfigured-source", requested: source.env, ...base };
    }
    if (!target.configured) return { kind: "unconfigured-target", ...base };

    return {
      kind: "ready",
      source: sourceDetail,
      target,
      sourceEnvironmentId: source.environmentId,
      sourceOptions: sources,
      appId: scope.appId,
      environmentId: scope.environmentId,
      scopeHref: base.scopeHref,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/flags/$flagKey/promote");
  },
  errorComponent: () => <SectionErrorPage title="Promotion unavailable" />,
  pendingComponent: TableSkeleton,
  component: PromotionRoute,
});

function PromotionRoute() {
  const loaded = Route.useLoaderData();

  if (loaded.kind !== "ready") return <PromotionBlockedPage blocked={loaded} />;

  return (
    <PromotionPage
      appId={loaded.appId}
      scopeHref={loaded.scopeHref}
      source={loaded.source}
      sourceEnvironmentId={loaded.sourceEnvironmentId}
      sourceOptions={loaded.sourceOptions}
      target={loaded.target}
      targetEnvironmentId={loaded.environmentId}
    />
  );
}

function PromotionBlockedPage({ blocked }: { blocked: PromotionBlocked }) {
  if (blocked.kind === "unknown-source") {
    return (
      <NotFoundPage
        description={`No Environment named "${blocked.requested}" is available in this App, so there is nothing to promote from.`}
        title="Unknown source Environment"
      />
    );
  }
  if (blocked.kind === "no-sources") {
    return (
      <NotFoundPage
        description={`${blocked.env} is the only Environment in this App. Promotion moves a Flag Configuration between two of them.`}
        title="Nothing to promote from"
      />
    );
  }
  return (
    <NotFoundPage
      description={
        blocked.kind === "unconfigured-source"
          ? `This Flag has no Configuration in ${blocked.requested}, so there is no Configuration to promote.`
          : `This Flag has no Configuration in ${blocked.env} yet, so there is nothing here for a Promotion to change.`
      }
      title="No Flag Configuration to promote"
    />
  );
}
