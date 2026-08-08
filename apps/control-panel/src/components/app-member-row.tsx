import type { AppMember, UserRole } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import { useState } from "react";
import {
  APP_ROLE_LABELS,
  type AppSettingsCapabilities,
  grantableRoles,
} from "#lib/app-settings-capabilities";
import {
  removeControlPanelAppMember,
  updateControlPanelAppMember,
} from "#lib/control-plane-app-settings-functions";

/**
 * One person's access to this App.
 *
 * `email` is null when the identity cache has no profile for them yet. That is
 * shown as an explicit absence rather than papered over with the user id, which
 * is plumbing an operator has no use for and never asked to see.
 */
export function AppMemberRow({
  appId,
  capabilities,
  member,
  onChanged,
  onError,
}: {
  appId: string;
  capabilities: AppSettingsCapabilities;
  member: AppMember;
  onChanged: () => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [isBusy, setIsBusy] = useState(false);

  async function run(mutate: () => Promise<ControlPlaneOperationResult<unknown>>) {
    onError(undefined);
    setIsBusy(true);
    try {
      const result = await mutate();
      if (!result.ok) {
        onError(result.error.message);
        return;
      }
      await onChanged();
    } catch {
      onError("The Control Plane did not answer. App access is unchanged.");
    } finally {
      setIsBusy(false);
    }
  }

  // Same confirmation shape as revoking an API Key: a named, reversible-by-hand
  // action gets a confirm, not the typed ceremony the App danger zone demands.
  function confirmRevoke() {
    const who = member.email ?? "this person";
    if (!globalThis.confirm(`Revoke ${who}'s access to this App? They can be granted it again.`)) {
      return;
    }
    void run(() => removeControlPanelAppMember({ data: { appId, userId: member.userId } }));
  }

  return (
    <TableRow data-app-member={member.userId}>
      <TableCell>
        {member.email ? (
          <span className="font-medium">{member.email}</span>
        ) : (
          <span className="text-muted-foreground italic">Email not available yet</span>
        )}
      </TableCell>
      <TableCell>
        {capabilities.canManageAccess ? (
          <Select
            disabled={isBusy}
            onValueChange={(value) =>
              run(() =>
                updateControlPanelAppMember({
                  data: { appId, userId: member.userId, role: value as UserRole },
                }),
              )
            }
            value={member.role}
          >
            <SelectTrigger aria-label="App role" className="w-36" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {grantableRoles(capabilities).map((role) => (
                  <SelectItem key={role} value={role}>
                    {APP_ROLE_LABELS[role]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="secondary">{APP_ROLE_LABELS[member.role]}</Badge>
        )}
      </TableCell>
      <TableCell>{member.createdAt.slice(0, 10)}</TableCell>
      <TableCell className="text-right">
        {capabilities.canManageAccess ? (
          <Button
            disabled={isBusy}
            onClick={confirmRevoke}
            size="sm"
            type="button"
            variant="destructive"
          >
            {isBusy ? "Working…" : "Revoke access"}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
