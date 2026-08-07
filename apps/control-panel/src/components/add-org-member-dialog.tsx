import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@splitch/ui/components/tooltip";
import { useState } from "react";
import { AddOrgMemberForm } from "#components/add-org-member-form";
import { canAddOrgMember } from "#lib/org-members";
import type { OrgRole } from "#lib/session";

/**
 * The one Add member path. A role that may not add sees the affordance locked
 * with the reason rather than hidden, and the Control Plane Worker refuses the
 * operation regardless of what the panel renders (ADR-0023).
 */
export function AddOrgMemberDialog({
  actorRole,
  onAdded,
  orgId,
}: {
  actorRole: OrgRole;
  onAdded: () => void | Promise<void>;
  orgId: string;
}) {
  const [open, setOpen] = useState(false);

  if (!canAddOrgMember(actorRole)) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button data-testid="add-member-locked" disabled type="button" variant="outline" />
          }
        >
          Add member (locked)
        </TooltipTrigger>
        <TooltipContent>
          Adding a member is an Organization owner or admin action. Your role is {actorRole}.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button data-testid="add-member" />}>Add member</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <AddOrgMemberForm
          actorRole={actorRole}
          onAdded={async () => {
            setOpen(false);
            await onAdded();
          }}
          orgId={orgId}
        />
      </DialogContent>
    </Dialog>
  );
}
