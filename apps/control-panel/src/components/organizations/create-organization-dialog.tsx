import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useState } from "react";
import { CreateOrganizationForm } from "#components/organizations/create-organization-form";
import type { StaleSession } from "#lib/sessions/stale-session";

/**
 * The one Create Organization path. Any signed-in User may take it: there is no
 * Organization to hold a role in yet, so there is no role to gate on. The Worker
 * still refuses a provisional (anonymous) principal, and that refusal is what the
 * form renders.
 */
export function CreateOrganizationDialog({
  className,
  label = "Create Organization",
  onCreated,
  onStaleSession,
  variant = "default",
}: {
  className?: string;
  label?: string;
  onCreated: (orgSlug: string) => void;
  onStaleSession: (stale: StaleSession) => void;
  variant?: "default" | "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button className={className} data-testid="create-organization" variant={variant} />
        }
      >
        {label}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <CreateOrganizationForm
          onCreated={(orgSlug) => {
            setOpen(false);
            onCreated(orgSlug);
          }}
          onStaleSession={(stale) => {
            setOpen(false);
            onStaleSession(stale);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
