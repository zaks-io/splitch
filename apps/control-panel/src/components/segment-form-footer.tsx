import type { PanelSegment } from "@splitch/control-plane-sdk/panel-segments";
import { Button } from "@splitch/ui/components/button";
import { DialogFooter } from "@splitch/ui/components/dialog";

export function SegmentFormFooter({
  busyAction,
  remove,
  segment,
}: {
  busyAction: "save" | "delete" | null;
  remove: () => void | Promise<void>;
  segment?: PanelSegment;
}) {
  return (
    <DialogFooter>
      {segment ? (
        <Button disabled={busyAction !== null} onClick={remove} type="button" variant="destructive">
          {busyAction === "delete" ? "Deleting…" : "Delete Segment"}
        </Button>
      ) : null}
      <Button disabled={busyAction !== null} type="submit">
        {busyAction === "save" ? "Saving…" : segment ? "Save Segment" : "Create Segment"}
      </Button>
    </DialogFooter>
  );
}
