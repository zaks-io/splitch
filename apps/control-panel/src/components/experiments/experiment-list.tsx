import type {
  PanelExperimentHealth,
  PanelExperimentListItem,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { ParityNote } from "#components/connect/parity-note";
import { parityHint } from "#lib/connect/parity-hints";
import { experimentKeyRouteRef } from "#lib/experiments/experiment-route-navigation";

type ExperimentListProps = {
  items: PanelExperimentListItem[];
  scopeHref: string;
};

export function ExperimentList({ items, scopeHref }: ExperimentListProps) {
  const newExperimentHref = `${scopeHref}/experiments/new`;
  if (items.length === 0) {
    return (
      <EmptyState
        action={<Button render={<a href={newExperimentHref}>New Experiment</a>} />}
        description={
          <>
            Experiments measure how a Flag change affects a goal Metric in this Environment. Create
            a draft, then Start its first Run when the setup is ready.
          </>
        }
        secondaryAction={<ParityNote hint={parityHint("experiments_create")} />}
        title="Create your first Experiment"
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Experiment</TableHead>
            <TableHead>Lifecycle</TableHead>
            <TableHead>Controlled Flag</TableHead>
            <TableHead>Run health</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((experiment) => (
            <ExperimentRow experiment={experiment} key={experiment.id} scopeHref={scopeHref} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ExperimentRow({
  experiment,
  scopeHref,
}: {
  experiment: PanelExperimentListItem;
  scopeHref: string;
}) {
  // An Experiment that has never opened a Run has no Results and no Run history
  // to show, so it links back into the flow that opens its first one. A `draft`
  // whose Run ended is NOT that: it keeps its detail screen.
  const experimentHref = `${scopeHref}/experiments/${experimentKeyRouteRef(experiment.key)}`;
  const detailHref =
    experiment.status === "draft" && !experiment.hasRuns
      ? `${experimentHref}/draft`
      : experimentHref;
  return (
    <TableRow className="group" data-experiment-id={experiment.id}>
      <TableCell className="font-medium">
        <a
          className="text-foreground underline-offset-4 group-hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={detailHref}
        >
          {experiment.name}
        </a>
      </TableCell>
      <TableCell>
        <LifecycleBadge status={experiment.status} />
      </TableCell>
      <TableCell>
        <span className="text-foreground text-sm">{experiment.flag.name}</span>
      </TableCell>
      <TableCell>
        <HealthBadges health={experiment.health} status={experiment.status} />
      </TableCell>
    </TableRow>
  );
}

function LifecycleBadge({ status }: { status: PanelExperimentListItem["status"] }) {
  const variant = status === "running" ? "secondary" : "outline";
  return <Badge variant={variant}>{capitalize(status)}</Badge>;
}

function HealthBadges({
  health,
  status,
}: {
  health: PanelExperimentHealth | null;
  status: PanelExperimentListItem["status"];
}) {
  if (status !== "running" || !health) {
    return <span className="text-muted-foreground text-sm">Not active</span>;
  }
  const badges = [
    health.srmFiring ? (
      <Badge key="srm" variant="destructive">
        SRM firing
      </Badge>
    ) : null,
    health.guardrailBreached ? (
      <Badge className="bg-warning-muted text-warning-foreground" key="guardrail">
        Guardrail breached
      </Badge>
    ) : null,
    health.significanceReached ? (
      <Badge className="bg-success-muted text-success-foreground" key="significance">
        Significance reached
      </Badge>
    ) : null,
  ].filter(Boolean);
  return badges.length > 0 ? (
    <div className="flex flex-wrap gap-1.5">{badges}</div>
  ) : (
    <Badge variant="outline">Collecting data</Badge>
  );
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
