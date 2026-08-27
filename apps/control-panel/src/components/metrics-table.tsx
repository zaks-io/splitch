import type { Metric, MetricKind } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { MetricEditorDialog } from "./metric-editor-dialog";

export function MetricsTable({
  appId,
  environmentId,
  metrics,
  onDeleted,
  onSaved,
}: {
  appId: string;
  environmentId: string;
  metrics: Metric[];
  onDeleted: (metricId: string) => void | Promise<void>;
  onSaved: (metric: Metric) => void | Promise<void>;
}) {
  const names = new Map(metrics.map((metric) => [metric.id, metric.name]));
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Metric</TableHead>
            <TableHead>Aggregation</TableHead>
            <TableHead>Fact</TableHead>
            <TableHead>Aggregation field</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.map((metric) => (
            <TableRow data-metric-key={metric.key} key={metric.id}>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{metric.name}</span>
                  <code className="font-mono text-muted-foreground text-xs">{metric.key}</code>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{kindLabel(metric.kind)}</Badge>
              </TableCell>
              <TableCell>
                <code className="font-mono text-sm">{fact(metric)}</code>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {aggregationField(metric, names)}
              </TableCell>
              <TableCell className="text-right">
                <MetricEditorDialog
                  appId={appId}
                  environmentId={environmentId}
                  metric={metric}
                  metrics={metrics}
                  onDeleted={onDeleted}
                  onSaved={onSaved}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function aggregationField(metric: Metric, names: Map<string, string>): string {
  if (metric.kind === "binomial") return "Event occurrence";
  if (metric.kind === "ratio") {
    const numerator = names.get(metric.numerator?.metricId ?? "") ?? "Missing numerator";
    const denominator = names.get(metric.denominator?.metricId ?? "") ?? "Missing denominator";
    return `${numerator} / ${denominator}`;
  }
  return metric.eventFieldName ?? "Missing value field";
}

// A Ratio has no Event Definition of its own; its operands are the Aggregation
// field. Repeating the numerator Metric name here read as a Fact identifier.
function fact(metric: Metric): string {
  if (metric.eventDefinitionId) return metric.eventDefinitionId;
  return metric.kind === "ratio" ? "Derived" : "Missing Event Definition";
}

function kindLabel(kind: MetricKind): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}
