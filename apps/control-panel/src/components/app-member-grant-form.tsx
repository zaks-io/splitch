import type { UserRole } from "@splitch/contracts";
import type { PanelAppAccessCandidate } from "@splitch/control-plane-sdk/panel-app-settings";
import { Button } from "@splitch/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { type FormEvent, useState } from "react";
import {
  APP_ROLE_LABELS,
  type AppSettingsCapabilities,
  grantableRoles,
} from "#lib/app-settings-capabilities";
import { addControlPanelAppMember } from "#lib/control-plane-app-settings-functions";

/**
 * Grants App access to someone who is already in the owning Organization.
 *
 * The person is picked from that Organization, never typed as a user id: App
 * access is granted from inside the Organization that owns the App, so the
 * candidates ARE the choices, and asking an operator to transcribe an internal
 * identifier would only invite a typo the Worker has to refuse.
 */
export function AppMemberGrantForm({
  appId,
  candidates,
  capabilities,
  onError,
  onGranted,
}: {
  appId: string;
  candidates: PanelAppAccessCandidate[];
  capabilities: AppSettingsCapabilities;
  onError: (message: string | undefined) => void;
  onGranted: () => Promise<void>;
}) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [isGranting, setIsGranting] = useState(false);
  const roles = grantableRoles(capabilities);
  // Base UI renders the raw selected value in the trigger unless the Root is
  // handed the value-to-label map (Select.Root `items`), and the raw value here
  // is an internal user id no operator asked to read.
  const candidateLabels = Object.fromEntries(
    candidates.map((candidate) => [candidate.userId, candidateLabel(candidate)]),
  );

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId) return;
    onError(undefined);
    setIsGranting(true);
    try {
      const result = await addControlPanelAppMember({ data: { appId, userId, role } });
      if (!result.ok) {
        onError(result.error.message);
        return;
      }
      setUserId("");
      setRole("member");
      await onGranted();
    } catch {
      onError("The Control Plane did not answer. App access is unchanged.");
    } finally {
      setIsGranting(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="app-grant-no-candidates">
        Everyone in this Organization already has access to this App. Add them to the Organization
        first to grant them access here.
      </p>
    );
  }

  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={grant}>
      <div className="grid min-w-64 flex-1 gap-2">
        <label className="font-medium text-sm" htmlFor="app-grant-person">
          Grant access to
        </label>
        <Select
          items={candidateLabels}
          onValueChange={(value) => setUserId(value ?? "")}
          value={userId}
        >
          <SelectTrigger className="w-full" id="app-grant-person">
            <SelectValue placeholder="Choose someone in this Organization" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.userId} value={candidate.userId}>
                  {candidateLabel(candidate)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="app-grant-role">
          Role
        </label>
        <Select
          items={APP_ROLE_LABELS}
          onValueChange={(value) => setRole(value as UserRole)}
          value={role}
        >
          <SelectTrigger className="w-36" id="app-grant-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {roles.map((option) => (
                <SelectItem key={option} value={option}>
                  {APP_ROLE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Button disabled={!userId || isGranting} type="submit">
        {isGranting ? "Granting…" : "Grant access"}
      </Button>
    </form>
  );
}

function candidateLabel(candidate: PanelAppAccessCandidate): string {
  return candidate.email ?? "Email not available yet";
}
