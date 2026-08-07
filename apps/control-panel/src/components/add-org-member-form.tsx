import type { UserRole } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { Input } from "@splitch/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { type FormEvent, useState } from "react";
import { addControlPanelOrgMember } from "#lib/control-plane-org-member-functions";
import { assignableRoles } from "#lib/org-members";
import type { OrgRole } from "#lib/session";

/**
 * Adding a member, not inviting one: the Control Plane's endpoint takes a
 * splitch User ID and sends no mail, so the form asks for exactly that and says
 * so. Calling it an invitation would promise an email that is never sent.
 */
export function AddOrgMemberForm({
  actorRole,
  onAdded,
  orgId,
}: {
  actorRole: OrgRole;
  onAdded: () => void | Promise<void>;
  orgId: string;
}) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = userId.trim();
    if (trimmed.length === 0) {
      setError("Enter the splitch User ID of the person to add.");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await addControlPanelOrgMember({ data: { orgId, userId: trimmed, role } });
      if (result.ok) await onAdded();
      else setError(result.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Control Plane could not be reached.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Add member</DialogTitle>
        <DialogDescription>
          The person must already have a splitch account. Adding them grants the Organization role
          you pick here immediately.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="member-user-id">
          splitch User ID
        </label>
        <Input
          aria-describedby="member-user-id-help"
          autoComplete="off"
          data-testid="add-member-user-id"
          id="member-user-id"
          name="userId"
          onChange={(event) => setUserId(event.target.value)}
          placeholder="user_01H..."
          value={userId}
        />
        <p className="text-muted-foreground text-xs" id="member-user-id-help">
          Shown in the user menu of the person&apos;s own splitch session.
        </p>
      </div>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="member-role">
          Organization role
        </label>
        <Select onValueChange={(next) => setRole(next as UserRole)} value={role}>
          <SelectTrigger className="w-full" data-testid="add-member-role" id="member-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {/* An admin may add members but never mint an owner, so the option
                  the Worker would refuse is not offered at all. */}
              {assignableRoles(actorRole).map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {candidate}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <Alert data-testid="add-member-error" variant="destructive">
          <AlertTitle>Member not added</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button disabled={isSubmitting} type="submit">
          {isSubmitting ? "Adding…" : "Add member"}
        </Button>
      </DialogFooter>
    </form>
  );
}
