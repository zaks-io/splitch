import type { OverviewExperiments } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { decisionReasonLabel } from "#lib/overview/overview-view";
import { OverviewUnavailable } from "#components/overview/overview-unavailable";

export function OverviewDecisionCard({
  experiments,
  onRetry,
  scopeHref,
}: {
  experiments: OverviewExperiments;
  onRetry: () => void;
  scopeHref: string;
}) {
  return (
    <Card data-overview-card="decision">
      <CardHeader>
        <CardTitle>Experiments needing a decision</CardTitle>
        <CardDescription>Runs whose locked decision family is ready to call.</CardDescription>
      </CardHeader>
      <CardContent>
        {experiments.status === "unavailable" ? (
          <OverviewUnavailable experiments={experiments} onRetry={onRetry} />
        ) : experiments.needingDecision.length === 0 ? (
          <p className="text-muted-foreground text-sm">No Experiment is waiting on a decision.</p>
        ) : (
          <ul className="grid gap-2">
            {experiments.needingDecision.map((experiment) => (
              <li key={experiment.id}>
                <a
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
                  data-overview-experiment={experiment.id}
                  href={`${scopeHref}/experiments/${encodeURIComponent(experiment.id)}/results`}
                >
                  <span className="font-medium text-foreground">{experiment.name}</span>
                  <span className="flex flex-wrap gap-1">
                    {experiment.reasons.map((reason) => (
                      <Badge key={reason} variant="outline">
                        {decisionReasonLabel(reason)}
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
