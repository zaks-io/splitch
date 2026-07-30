import type { Metric } from "@splitch/contracts";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { useEffect, useState } from "react";
import { MetricEditorDialog } from "./metric-editor-dialog";
import { MetricsTable } from "./metrics-table";

export function MetricsPage({
  appId,
  environmentId,
  metrics,
}: {
  appId: string;
  environmentId: string;
  metrics: Metric[];
}) {
  const [visibleMetrics, setVisibleMetrics] = useState(metrics);

  useEffect(() => setVisibleMetrics(metrics), [metrics]);

  function saveMetric(metric: Metric) {
    setVisibleMetrics((current) => upsertMetric(current, metric));
  }

  function deleteMetric(metricId: string) {
    setVisibleMetrics((current) => removeMetric(current, metricId));
  }

  return (
    <section aria-labelledby="metrics-title" className="grid gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
            Defined once, available in every Environment
          </p>
          <h1 className="font-semibold text-3xl text-foreground tracking-tight" id="metrics-title">
            Metrics (App-level)
          </h1>
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">
            Define each fact and aggregation for this App. Choose a Metric&apos;s role per
            Experiment.
          </p>
        </div>
        {visibleMetrics.length > 0 ? (
          <MetricEditorDialog
            appId={appId}
            environmentId={environmentId}
            metrics={visibleMetrics}
            onDeleted={deleteMetric}
            onSaved={saveMetric}
          />
        ) : null}
      </header>

      {visibleMetrics.length > 0 ? (
        <MetricsTable
          appId={appId}
          environmentId={environmentId}
          metrics={visibleMetrics}
          onDeleted={deleteMetric}
          onSaved={saveMetric}
        />
      ) : (
        <EmptyState
          action={
            <MetricEditorDialog
              appId={appId}
              environmentId={environmentId}
              metrics={visibleMetrics}
              onDeleted={deleteMetric}
              onSaved={saveMetric}
            />
          }
          description="A Metric combines an event fact with a Binomial, Count, Revenue, or Ratio aggregation."
          secondaryAction={
            <code className="rounded bg-muted px-2 py-1 font-mono text-muted-foreground text-xs">
              splitch metrics create
            </code>
          }
          title="Create your first Metric"
        />
      )}
    </section>
  );
}

export function upsertMetric(metrics: readonly Metric[], metric: Metric): Metric[] {
  if (!metrics.some(({ id }) => id === metric.id)) return [...metrics, metric];
  return metrics.map((candidate) => (candidate.id === metric.id ? metric : candidate));
}

export function removeMetric(metrics: readonly Metric[], metricId: string): Metric[] {
  return metrics.filter(({ id }) => id !== metricId);
}
