import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CreateFlagForm } from "./create-flag-form";
import { CreateFlagSuccess } from "./create-flag-success";

export function CreateFlagDialog({
  appId,
  environmentId,
}: {
  appId: string;
  environmentId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string>();

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      if (createdKey) void router.invalidate();
      setCreatedKey(undefined);
    }
  }

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger render={<Button />}>Create Flag</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {createdKey ? (
          <CreateFlagSuccess flagKey={createdKey} />
        ) : (
          <CreateFlagForm appId={appId} environmentId={environmentId} onCreated={setCreatedKey} />
        )}
      </DialogContent>
    </Dialog>
  );
}
