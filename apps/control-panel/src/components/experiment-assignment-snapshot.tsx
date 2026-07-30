import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Badge } from "@splitch/ui/components/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";

export function ExperimentAssignmentSnapshot({
  data,
  run,
}: {
  data: PanelExperimentDetailOutput;
  run: PanelExperimentRun | undefined;
}) {
  if (!run) return null;
  const variants = variantNames(run.variantsJson);
  const activationMetric = metricName(data, run.activationMetricId);

  return (
    <Card data-testid="frozen-assignment">
      <CardHeader>
        <CardTitle>Assignment configuration</CardTitle>
        <CardDescription>
          Bucketing fields are frozen for Run {run.runNumber}. Configure a new Run to change them.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">Locked · Run {run.runNumber}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          <SnapshotValue label="Targeting Key" value={run.targetingKey} />
          <SnapshotValue label="Entity type" value={run.targetingKeyType} />
          <SnapshotValue label="Salt" mono value={run.salt} />
          <SnapshotValue label="Activation Metric" value={activationMetric} />
          <SnapshotValue label="Variants" value={variants.join(", ") || "None"} />
          <SnapshotValue label="Allocation" value={formatAllocation(run.allocation)} />
          <SnapshotValue
            className="sm:col-span-2"
            label="Targeting"
            mono
            value={prettyJson(run.targetingRulesJson)}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function SnapshotValue({
  className,
  label,
  mono = false,
  value,
}: {
  className?: string;
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className={className}>
      <dt className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className={`mt-1 whitespace-pre-wrap text-foreground text-sm ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function metricName(data: PanelExperimentDetailOutput, metricId: string | null): string {
  if (!metricId) return "None";
  const metric = data.metrics.find((candidate) => candidate.id === metricId);
  return metric ? `${metric.name} (${metric.id})` : metricId;
}

function variantNames(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as Array<{ name?: unknown }>;
    return value.flatMap((variant) => (typeof variant.name === "string" ? [variant.name] : []));
  } catch {
    return [];
  }
}

function formatAllocation(allocation: Record<string, number>): string {
  return Object.entries(allocation)
    .map(([name, share]) => `${name} ${share}%`)
    .join(" · ");
}

function prettyJson(raw: string): string {
  try {
    const value = JSON.parse(raw) as unknown[];
    return value.length === 0 ? "All eligible traffic" : JSON.stringify(value, null, 2);
  } catch {
    return raw;
  }
}
