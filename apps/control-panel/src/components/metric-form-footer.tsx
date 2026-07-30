import type { Metric } from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";
import { DialogFooter } from "@splitch/ui/components/dialog";

export function MetricFormFooter({
  busyAction,
  metric,
  remove,
}: {
  busyAction: "save" | "delete" | null;
  metric?: Metric;
  remove: () => void | Promise<void>;
}) {
  return (
    <DialogFooter>
      {metric ? (
        <Button disabled={busyAction !== null} onClick={remove} type="button" variant="destructive">
          {busyAction === "delete" ? "Deleting…" : "Delete Metric"}
        </Button>
      ) : null}
      <Button disabled={busyAction !== null} type="submit">
        {busyAction === "save" ? "Saving…" : metric ? "Save Metric" : "Create Metric"}
      </Button>
    </DialogFooter>
  );
}
