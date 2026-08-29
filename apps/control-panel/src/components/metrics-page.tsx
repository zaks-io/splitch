import type { Metric } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { renderMetricImplementationPrompt } from "#lib/implementation-prompt";
import { parityHint } from "#lib/parity-hints";
import { CatalogTruncatedNotice } from "./catalog-truncated-notice";
import { CodeAgentPrompt } from "./code-agent-prompt";
import { MetricEditorDialog } from "./metric-editor-dialog";
import { ParityNote } from "./parity-note";
import { MetricsTable } from "./metrics-table";

export function MetricsPage({
  appId,
  clientKey,
  environment,
  environmentId,
  eventDefinitions,
  metrics,
  readLimit,
  readTruncated,
}: {
  appId: string;
  clientKey?: string;
  environment?: string;
  environmentId: string;
  eventDefinitions: Array<{ id: string; name: string }>;
  metrics: Metric[];
  readLimit: number;
  readTruncated: boolean;
}) {
  const router = useRouter();
  const [implementationMetric, setImplementationMetric] = useState<Metric>();

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

  async function rereadAndShowPrompt(metric: Metric) {
    await router.invalidate();
    setImplementationMetric(metric);
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
            onSaved={rereadAndShowPrompt}
          />
        ) : null}
      </header>

      {readTruncated ? (
        <CatalogTruncatedNotice
          nounPlural="Metrics"
          readLimit={readLimit}
          scopeNoun="App"
          shownCount={metrics.length}
          testId="metrics-truncated"
        />
      ) : null}

      {metrics.length > 0 ? (
        <MetricsTable
          appId={appId}
          environmentId={environmentId}
          metrics={metrics}
          onDeleted={reread}
          onSaved={rereadAndShowPrompt}
        />
      ) : (
        <EmptyState
          action={
            <MetricEditorDialog
              appId={appId}
              environmentId={environmentId}
              metrics={metrics}
              onDeleted={reread}
              onSaved={rereadAndShowPrompt}
            />
          }
          description="A Metric combines an event fact with a Binomial, Count, Revenue, or Ratio aggregation."
          secondaryAction={<ParityNote hint={parityHint("metrics_create")} />}
          title="Create your first Metric"
        />
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setImplementationMetric(undefined);
        }}
        open={implementationMetric !== undefined}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
          {implementationMetric ? (
            <div className="grid gap-5" data-testid="metric-code-agent-success">
              <DialogHeader>
                <DialogTitle>Implement {implementationMetric.name}</DialogTitle>
              </DialogHeader>
              {clientKey ? (
                <CodeAgentPrompt
                  prompt={renderMetricImplementationPrompt({
                    clientKey,
                    environment,
                    eventDefinitions,
                    metric: implementationMetric,
                    metrics,
                  })}
                  testId="metric-code-agent-prompt"
                />
              ) : (
                <Alert variant="destructive">
                  <AlertTitle>Code-agent prompt unavailable</AlertTitle>
                  <AlertDescription>
                    The Metric was saved, but the public Client Key could not be loaded. Reload this
                    page or copy it from Environment settings before implementing the Metric.
                  </AlertDescription>
                </Alert>
              )}
              <DialogFooter showCloseButton />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
