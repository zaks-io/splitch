import type { OverviewExperiments } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { failureReasonLabel } from "#lib/overview/overview-view";
import { OverviewUnavailable } from "#components/overview/overview-unavailable";

export function OverviewFailureCard({
  experiments,
  onRetry,
  scopeHref,
}: {
  experiments: OverviewExperiments;
  onRetry: () => void;
  scopeHref: string;
}) {
  return (
    <Card data-overview-card="failure">
      <CardHeader>
        <CardTitle>Experiments in a failure state</CardTitle>
        <CardDescription>
          SRM, breached Guardrails, and multiple-assignment quarantine.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {experiments.status === "unavailable" ? (
          <OverviewUnavailable experiments={experiments} onRetry={onRetry} />
        ) : experiments.failing.length === 0 ? (
          <p className="text-muted-foreground text-sm">No running Experiment is failing.</p>
        ) : (
          <ul className="grid gap-2">
            {experiments.failing.map((experiment) => (
              <li key={experiment.id}>
                <a
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm hover:bg-accent"
                  data-overview-experiment={experiment.id}
                  href={`${scopeHref}/experiments/${encodeURIComponent(experiment.id)}/results`}
                >
                  <span className="font-medium text-foreground">{experiment.name}</span>
                  <span className="flex flex-wrap gap-1">
                    {experiment.reasons.map((reason) => (
                      <Badge key={reason} variant="destructive">
                        {failureReasonLabel(reason)}
                      </Badge>
                    ))}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
