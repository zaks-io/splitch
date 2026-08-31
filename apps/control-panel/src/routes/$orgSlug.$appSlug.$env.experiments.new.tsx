import { createFileRoute } from "@tanstack/react-router";
import { ExperimentCreateForm } from "#components/experiments/experiment-create-form";
import { PanelPageBody } from "#components/shell/panel-page-body";
import { SectionPending } from "#components/shared/section-pending";
import { SectionUnavailable } from "#components/shared/section-unavailable";
import { scopedHref } from "#lib/shell/app-shell-navigation";
import { loadControlPanelFlags } from "#lib/flags/control-plane-flag-functions";
import { reportRouteError } from "#lib/observability/panel-observability";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env/experiments/new")({
  loader: async ({ context }) => {
    const scoped = context.scoped;
    // An Experiment controls exactly one Flag, so the Flag catalog is what step 1
    // is choosing from. Reusing the Flags page read keeps one source for it.
    const flags = await loadControlPanelFlags({ data: scoped.scope });
    if (!flags.ok) throw new Error(flags.error.message);
    return {
      flags: flags.data.items.map((item) => item.definition),
      scope: scoped.scope,
    };
  },
  onError: ({ error }) => {
    reportRouteError("section", error, "/$orgSlug/$appSlug/$env/experiments/new");
  },
  errorComponent: () => <SectionUnavailable title="Experiment creation unavailable" />,
  pendingComponent: SectionPending,
  component: NewExperimentRoute,
});

function NewExperimentRoute() {
  const { flags, scope } = Route.useLoaderData();
  return (
    <PanelPageBody>
      <div className="mx-auto w-full max-w-2xl">
        <ExperimentCreateForm flags={flags} scope={scope} scopeHref={scopedHref(scope)} />
      </div>
    </PanelPageBody>
  );
}
