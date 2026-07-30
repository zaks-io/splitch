import type { Metric } from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useHydrated } from "#lib/use-hydrated";
import { useState } from "react";
import { MetricForm } from "./metric-form";

export function MetricEditorDialog({
  appId,
  environmentId,
  metric,
  metrics,
  onDeleted,
  onSaved,
}: {
  appId: string;
  environmentId: string;
  metric?: Metric;
  metrics: Metric[];
  onDeleted: (metricId: string) => void | Promise<void>;
  onSaved: (metric: Metric) => void | Promise<void>;
}) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);

  async function saved(savedMetric: Metric) {
    setOpen(false);
    await onSaved(savedMetric);
  }

  async function deleted(metricId: string) {
    setOpen(false);
    await onDeleted(metricId);
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        disabled={!hydrated}
        render={
          <Button size={metric ? "sm" : "default"} variant={metric ? "outline" : "default"} />
        }
      >
        {metric ? `Edit ${metric.name}` : "Create Metric"}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <MetricForm
          appId={appId}
          environmentId={environmentId}
          metric={metric}
          metrics={metrics}
          onDeleted={deleted}
          onSaved={saved}
        />
      </DialogContent>
    </Dialog>
  );
}
