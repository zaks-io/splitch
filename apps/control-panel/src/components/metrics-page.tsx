import type { Metric } from "@splitch/contracts";
import { EmptyState } from "@splitch/ui/state/empty-state";
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
        {metrics.length > 0 ? (
          <MetricEditorDialog appId={appId} environmentId={environmentId} metrics={metrics} />
        ) : null}
      </header>

      {metrics.length > 0 ? (
        <MetricsTable appId={appId} environmentId={environmentId} metrics={metrics} />
      ) : (
        <EmptyState
          action={
            <MetricEditorDialog appId={appId} environmentId={environmentId} metrics={metrics} />
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
