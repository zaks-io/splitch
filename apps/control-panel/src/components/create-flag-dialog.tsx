import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CreateFlagForm } from "./create-flag-form";
import { CreateFlagSuccess } from "./create-flag-success";

export function CreateFlagDialog({
  appId,
  environmentId,
  onClosedAfterCreate,
  settingsHref,
}: {
  appId: string;
  environmentId: string;
  settingsHref: string;
  onClosedAfterCreate?: (key: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string>();

  async function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
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
      <DialogTrigger render={<Button />}>Create Flag</DialogTrigger>
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
