import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@splitch/ui/components/tooltip";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CreateAppForm } from "#components/create-app-form";
import { StaleSessionNotice } from "#components/stale-session-notice";
import { canCreateApp } from "#lib/org-app-list";
import type { OrgRole } from "#lib/session";

/**
 * The one Create App path. A `member` gets the affordance rendered locked with
 * the reason, not hidden — a missing button teaches nothing — and the Control
 * Plane Worker refuses the operation regardless of what the panel renders.
 */
export function CreateAppDialog({ orgId, orgRole }: { orgId: string; orgRole: OrgRole }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Not cleared on the next open: the notice below the dialog is the only place
  // this App's create is ever surfaced, since the session list it would appear
  // in is exactly what is stale (SPL-203).
  const [staleAppSlug, setStaleAppSlug] = useState<string | null>(null);

  if (!canCreateApp(orgRole)) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button data-testid="create-app-locked" disabled type="button" variant="outline" />
          }
        >
          Create App (locked)
        </TooltipTrigger>
        <TooltipContent>
          Creating an App is an Organization owner or admin action. Your role is {orgRole}.
        </TooltipContent>
      </Tooltip>
    );
  }

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
  }

  return (
    <div className="grid gap-3">
      {staleAppSlug ? <StaleSessionNotice resource="App" slug={staleAppSlug} /> : null}
      <Dialog onOpenChange={changeOpen} open={open}>
        <DialogTrigger render={<Button data-testid="create-app" />}>Create App</DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <CreateAppForm
            onCreated={() => {
              setOpen(false);
              void router.invalidate();
            }}
            onStaleSession={(appSlug) => {
              setOpen(false);
              setStaleAppSlug(appSlug);
            }}
            orgId={orgId}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
