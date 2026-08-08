import type { UserRole } from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { useState } from "react";
import {
  removeControlPanelOrgMember,
  updateControlPanelOrgMemberRole,
} from "#lib/control-plane-org-member-functions";
import {
  assignableRoles,
  canChangeOrgMemberRole,
  canRemoveOrgMember,
  organizationRoleLabel,
} from "#lib/org-members";
import type { OrgMember } from "#lib/org-members";
import type { OrgRole } from "#lib/session";

/**
 * Per-member role change and removal. Both are owner-only in the Control Plane,
 * so an admin sees the reason in place of controls they cannot use.
 *
 * The sole owner's controls are locked for the same reason the Worker refuses
 * them (`LAST_OWNER_REQUIRED`): an Organization must keep an owner. Stating it
 * here turns the refusal into an explanation; the Worker still decides.
 */
export function OrgMemberActions({
  actorRole,
  isSoleOwner,
  member,
  onChanged,
  orgId,
}: {
  actorRole: OrgRole;
  isSoleOwner: boolean;
  member: OrgMember;
  onChanged: () => void | Promise<void>;
  orgId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const canChange = canChangeOrgMemberRole(actorRole);
  const canRemove = canRemoveOrgMember(actorRole);

  if (!canChange && !canRemove) {
    return (
      <p
        className="max-w-64 text-muted-foreground text-xs"
        data-testid={`member-actions-locked-${member.userId}`}
      >
        Changing roles and removing members requires the Owner role.
      </p>
    );
  }

  async function run(mutate: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setError(null);
    setIsBusy(true);
    try {
      const result = await mutate();
      // Re-read, never patch: the row comes back from the Control Plane on the
      // next loader run, so nothing is spliced into local state (ADR-0036).
      if (result.ok) await onChanged();
      else setError(result.error?.message ?? "The Control Plane refused the change.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Control Plane could not be reached.");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex items-center justify-end gap-2">
        <Select
          disabled={isBusy || isSoleOwner || !canChange}
          onValueChange={(role) =>
            run(() =>
              updateControlPanelOrgMemberRole({
                data: { orgId, userId: member.userId, role: role as UserRole },
              }),
            )
          }
          value={member.role}
        >
          <SelectTrigger
            aria-label={`Role for ${member.email ?? member.userId}`}
            className="w-36"
            data-testid={`member-role-${member.userId}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {assignableRoles(actorRole).map((role) => (
                <SelectItem key={role} value={role}>
                  {organizationRoleLabel(role)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          data-testid={`member-remove-${member.userId}`}
          disabled={isBusy || isSoleOwner || !canRemove}
          onClick={() =>
            run(() => removeControlPanelOrgMember({ data: { orgId, userId: member.userId } }))
          }
          type="button"
          variant="outline"
        >
          Remove
        </Button>
      </div>
      {isSoleOwner ? (
        <p className="text-muted-foreground text-xs">
          The only owner. Promote another member to owner first.
        </p>
      ) : null}
      {error ? (
        <p
          className="text-destructive text-xs"
          data-testid={`member-error-${member.userId}`}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
