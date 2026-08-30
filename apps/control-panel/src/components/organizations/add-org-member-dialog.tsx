import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useState } from "react";
import { AddOrgMemberForm } from "#components/organizations/add-org-member-form";
import { canAddOrgMember } from "#lib/organizations/org-members";
import type { OrgRole } from "#lib/sessions/session";

/**
 * The one Add member path. A role that may not add sees the reason in place of
 * the control, and the Control Plane Worker refuses the operation regardless of
 * what the panel renders (ADR-0023).
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
      <p className="max-w-64 text-muted-foreground text-xs" data-testid="add-member-locked">
        Adding a member requires the Owner or Admin role.
      </p>
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
