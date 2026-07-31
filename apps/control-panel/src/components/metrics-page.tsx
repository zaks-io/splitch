import type { Metric } from "@splitch/contracts";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { useRouter } from "@tanstack/react-router";
import { parityHint } from "#lib/parity-hints";
import { MetricEditorDialog } from "./metric-editor-dialog";
import { ParityNote } from "./parity-note";
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
  const router = useRouter();

  /*
   * Re-read, never patch: `metrics` is route-loader data with no React Query
   * cache in front of it, so invalidating the route is the whole read-back.
   * Splicing the write's own response into local state would show the operator
   * a row the Panel never read back from the Control Plane -- the disguised
   * default ADR-0036 forbids, and the reason no surface here keeps a local
   * mirror of server state (ADR-0023).
   */
  async function reread() {
    await router.invalidate();
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
        {metrics.length > 0 ? (
          <MetricEditorDialog
            appId={appId}
            environmentId={environmentId}
            metrics={metrics}
            onDeleted={reread}
            onSaved={reread}
          />
        ) : null}
      </header>

      {metrics.length > 0 ? (
        <MetricsTable
          appId={appId}
          environmentId={environmentId}
          metrics={metrics}
          onDeleted={reread}
          onSaved={reread}
        />
      ) : (
        <EmptyState
          action={
            <MetricEditorDialog
              appId={appId}
              environmentId={environmentId}
              metrics={metrics}
              onDeleted={reread}
              onSaved={reread}
            />
          }
          description="A Metric combines an event fact with a Binomial, Count, Revenue, or Ratio aggregation."
          secondaryAction={<ParityNote hint={parityHint("metrics_create")} />}
          title="Create your first Metric"
        />
      )}
    </section>
  );
}
