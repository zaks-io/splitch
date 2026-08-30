import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { CreatedFlagHandoff } from "#lib/flags/control-plane-flag-functions";
import { CreateFlagForm } from "#components/flags/create-flag-form";
import { CreateFlagSuccess } from "#components/flags/create-flag-success";

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
  const [createdFlag, setCreatedFlag] = useState<CreatedFlagHandoff>();
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
    if (nextOpen || !createdFlag) return;

    const key = createdFlag.key;
    try {
      await router.invalidate();
      onClosedAfterCreate?.(key);
    } finally {
      setCreatedFlag(undefined);
    }
  }

  return (
    <Dialog onOpenChange={(nextOpen) => void changeOpen(nextOpen)} open={open}>
      {trigger}
      <DialogContent className="sm:max-w-lg">
        {createdFlag ? (
          <CreateFlagSuccess
            appId={appId}
            environmentId={environmentId}
            flag={createdFlag}
            settingsHref={settingsHref}
          />
        ) : (
          <CreateFlagForm appId={appId} environmentId={environmentId} onCreated={setCreatedFlag} />
        )}
      </DialogContent>
    </Dialog>
  );
}
