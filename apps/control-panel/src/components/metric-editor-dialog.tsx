import type { Metric } from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { MetricForm } from "./metric-form";

export function MetricEditorDialog({
  appId,
  environmentId,
  metric,
  metrics,
}: {
  appId: string;
  environmentId: string;
  metric?: Metric;
  metrics: Metric[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function saved() {
    setOpen(false);
    await router.invalidate();
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
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
          onSaved={saved}
        />
      </DialogContent>
    </Dialog>
  );
}
