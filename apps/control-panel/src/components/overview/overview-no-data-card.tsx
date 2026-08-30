import type { OverviewExperiments } from "@splitch/contracts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";

/**
 * Running Experiments Analysis returned no result for.
 *
 * The read succeeded and the answer was "not yet", which is neither attention nor
 * a clean bill of health. Rendering these as unknown is what keeps them out of the
 * calm state instead of being quietly subtracted from it (ADR-0036).
 */
export function OverviewNoDataCard({
  experiments,
  scopeHref,
}: {
  experiments: Extract<OverviewExperiments, { status: "ok" }>;
  scopeHref: string;
}) {
  return (
    <Card data-overview-card="no-data">
      <CardHeader>
        <CardTitle>Experiments with no results yet</CardTitle>
        <CardDescription>
          Analysis has no results for these running Runs, so their state is unknown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2">
          {experiments.noData.map((experiment) => (
            <li key={experiment.id}>
              <a
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
                data-overview-no-data={experiment.id}
                href={`${scopeHref}/experiments/${encodeURIComponent(experiment.id)}/results`}
              >
                <span className="font-medium text-foreground">{experiment.name}</span>
                <span className="text-muted-foreground">No results yet</span>
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
