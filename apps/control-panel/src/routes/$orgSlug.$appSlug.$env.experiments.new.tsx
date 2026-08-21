import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExperimentCreateForm } from "#components/experiment-create-form";
import { scopedHref } from "#lib/app-shell-navigation";
import { loadControlPanelFlags } from "#lib/control-plane-flag-functions";
import { AccessDeniedError } from "#lib/loader-context";
import { loginRedirect } from "#lib/login-redirect";
import { reportRouteError } from "#lib/panel-observability";
import { loadScopedSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/new")({
  loader: async ({ location, params }) => {
    const scoped = await loadScopedSession({ data: params });
    if (scoped.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    if (scoped.kind === "forbidden") throw new AccessDeniedError();
    if (scoped.kind === "notFound") throw notFound();

    // An Experiment controls exactly one Flag, so the Flag catalog is what step 1
    // is choosing from. Reusing the Flags page read keeps one source for it.
    const flags = await loadControlPanelFlags({ data: scoped.context.scope });
    if (!flags.ok) throw new Error(flags.error.message);
    return {
      flags: flags.data.items.map((item) => item.definition),
      scope: scoped.context.scope,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments/new");
  },
  errorComponent: () => <SectionErrorPage title="Experiment creation unavailable" />,
  pendingComponent: TableSkeleton,
  component: NewExperimentRoute,
});

function NewExperimentRoute() {
  const { flags, scope } = Route.useLoaderData();
  return (
    <div className="mx-auto w-full max-w-2xl">
      <ExperimentCreateForm flags={flags} scope={scope} scopeHref={scopedHref(scope)} />
    </div>
  );
}
