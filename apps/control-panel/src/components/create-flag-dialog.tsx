import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { CreateFlagForm } from "./create-flag-form";
import { CreateFlagSuccess } from "./create-flag-success";

export function CreateFlagDialog({
  appId,
  environmentId,
  onClosedAfterCreate,
  onOpenChange,
  open: controlledOpen,
  settingsHref,
  trigger = <DialogTrigger render={<Button />}>Create Flag</DialogTrigger>,
}: {
  appId: string;
  environmentId: string;
  settingsHref: string;
  onClosedAfterCreate?: (key: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
}) {
  const router = useRouter();
  const [internalOpen, setInternalOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string>();
  const isControlled = controlledOpen !== undefined;
  if (isControlled && !onOpenChange) {
    throw new Error("Controlled CreateFlagDialog requires onOpenChange");
  }
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;

  async function changeOpen(nextOpen: boolean) {
    if (isControlled) onOpenChange?.(nextOpen);
    else {
      setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    }
    if (nextOpen || !createdKey) return;

    const key = createdKey;
    try {
      await router.invalidate();
      onClosedAfterCreate?.(key);
    } finally {
      setCreatedKey(undefined);
    }
  }

  return (
    <Dialog onOpenChange={(nextOpen) => void changeOpen(nextOpen)} open={open}>
      {trigger}
      <DialogContent className="sm:max-w-lg">
        {createdKey ? (
          <CreateFlagSuccess
            appId={appId}
            environmentId={environmentId}
            flagKey={createdKey}
            settingsHref={settingsHref}
          />
        ) : (
          <CreateFlagForm appId={appId} environmentId={environmentId} onCreated={setCreatedKey} />
        )}
      </DialogContent>
    </Dialog>
  );
}
