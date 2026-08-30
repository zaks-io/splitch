import type { PanelSegment } from "@splitch/control-plane-sdk/panel-segments";
import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useState } from "react";
import { useHydrated } from "#lib/shared/use-hydrated";
import { SegmentForm } from "#components/segments/segment-form";

export function SegmentEditorDialog({
  appId,
  environmentId,
  onDeleted,
  onSaved,
  segment,
}: {
  appId: string;
  environmentId: string;
  onDeleted: (segmentId: string) => void | Promise<void>;
  onSaved: (segment: PanelSegment) => void | Promise<void>;
  segment?: PanelSegment;
}) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);

  async function saved(savedSegment: PanelSegment) {
    setOpen(false);
    await onSaved(savedSegment);
  }

  async function deleted(segmentId: string) {
    setOpen(false);
    await onDeleted(segmentId);
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        disabled={!hydrated}
        render={
          <Button size={segment ? "sm" : "default"} variant={segment ? "outline" : "default"} />
        }
      >
        {segment ? `Edit ${segment.name}` : "Create Segment"}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <SegmentForm
          appId={appId}
          environmentId={environmentId}
          onDeleted={deleted}
          onSaved={saved}
          segment={segment}
        />
      </DialogContent>
    </Dialog>
  );
}
