import { Badge } from "@splitch/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { OrgMemberActions } from "#components/organizations/org-member-actions";
import { isLastOwner, type OrgMember, organizationRoleLabel } from "#lib/organizations/org-members";
import type { OrgRole } from "#lib/sessions/session";

export function OrgMembersTable({
  actorRole,
  actorUserId,
  members,
  onChanged,
  orgId,
}: {
  actorRole: OrgRole;
  actorUserId: string;
  members: readonly OrgMember[];
  onChanged: () => void | Promise<void>;
  orgId: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Organization role</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow data-member-id={member.userId} key={member.userId}>
              <TableCell>
                <div className="flex flex-col gap-1">
                  {member.email ? (
                    <span className="font-medium">{member.email}</span>
                  ) : (
                    <span className="font-medium text-muted-foreground">Email unavailable</span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{organizationRoleLabel(member.role)}</Badge>
                  {member.userId === actorUserId ? <Badge>You</Badge> : null}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <OrgMemberActions
                  actorRole={actorRole}
                  isSoleOwner={isLastOwner(members, member.userId)}
                  member={member}
                  onChanged={onChanged}
                  orgId={orgId}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
