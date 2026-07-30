import type { AppOverviewResponse } from "@splitch/contracts";
import { isCalmOverview } from "#lib/overview-view";
import { OverviewCalmState } from "./overview-calm-state";
import { OverviewDecisionCard } from "./overview-decision-card";
import { OverviewEnvironmentCard } from "./overview-environment-card";
import { OverviewFailureCard } from "./overview-failure-card";
import { OverviewFlagChangesCard } from "./overview-flag-changes-card";
import { OverviewNoDataCard } from "./overview-no-data-card";

export function OverviewPage({
  env,
  onRetry,
  overview,
  scopeHref,
}: {
  env: string;
  onRetry: () => void;
  overview: AppOverviewResponse;
  scopeHref: string;
}) {
  // Calm is a positive finding, not the absence of one: it requires every section
  // to have been read successfully and to be empty (ADR-0036).
  const calm = isCalmOverview({
    experiments: overview.experiments,
    flagChangesTruncated: overview.flagConfiguration.readTruncated,
    recentlyChanged: overview.flagConfiguration.recentlyChanged,
  });

  return (
    <section aria-labelledby="overview-title" className="grid gap-6" data-overview="ready">
      <header className="grid gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
          {env} Environment
        </p>
        <h1 className="font-semibold text-3xl text-foreground tracking-tight" id="overview-title">
          Overview
        </h1>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {calm ? (
          <div className="lg:col-span-2" data-overview-state="calm">
            <OverviewCalmState scopeHref={scopeHref} />
          </div>
        ) : (
          <>
            <OverviewDecisionCard
              experiments={overview.experiments}
              onRetry={onRetry}
              scopeHref={scopeHref}
            />
            <OverviewFailureCard
              experiments={overview.experiments}
              onRetry={onRetry}
              scopeHref={scopeHref}
            />
            <OverviewFlagChangesCard
              changedCount={overview.flagConfiguration.changedCount}
              readLimit={overview.flagConfiguration.readLimit}
              readTruncated={overview.flagConfiguration.readTruncated}
              recentlyChanged={overview.flagConfiguration.recentlyChanged}
              scopeHref={scopeHref}
              windowDays={overview.flagConfiguration.windowDays}
            />
            {overview.experiments.status === "ok" && overview.experiments.noData.length > 0 ? (
              <OverviewNoDataCard experiments={overview.experiments} scopeHref={scopeHref} />
            ) : null}
          </>
        )}
        <OverviewEnvironmentCard
          environmentKey={overview.environment.key}
          name={overview.environment.name}
          policy={overview.environment.policy}
          scopeHref={scopeHref}
        />
      </div>
    </section>
  );
}
