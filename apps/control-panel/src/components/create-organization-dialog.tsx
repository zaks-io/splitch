import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useState } from "react";
import { CreateOrganizationForm } from "#components/create-organization-form";

/**
 * The one Create Organization path. Any signed-in User may take it: there is no
 * Organization to hold a role in yet, so there is no role to gate on. The Worker
 * still refuses a provisional (anonymous) principal, and that refusal is what the
 * form renders.
 */
export function CreateOrganizationDialog({
  label = "Create Organization",
  onCreated,
  onStaleSession,
  variant = "default",
}: {
  label?: string;
  onCreated: (orgSlug: string) => void;
  onStaleSession: (orgSlug: string) => void;
  variant?: "default" | "outline";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button data-testid="create-organization" variant={variant} />}>
        {label}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <CreateOrganizationForm
          onCreated={(orgSlug) => {
            setOpen(false);
            onCreated(orgSlug);
          }}
          onStaleSession={(orgSlug) => {
            setOpen(false);
            onStaleSession(orgSlug);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
