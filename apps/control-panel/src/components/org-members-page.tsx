import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { useRouter } from "@tanstack/react-router";
import { AddOrgMemberDialog } from "#components/add-org-member-dialog";
import { OrgMembersTable } from "#components/org-members-table";
import { ParityNote } from "#components/parity-note";
import { SsoScimCard } from "#components/sso-scim-card";
import type { OrgMembersView } from "#lib/org-members";
import { parityHint } from "#lib/parity-hints";

/** The Members screen: `/{orgSlug}/members`. Org membership, not App membership. */
export function OrgMembersPage({ view }: { view: OrgMembersView }) {
  const router = useRouter();

  /*
   * Re-read, never patch: the member rows are route-loader data, so invalidating
   * the route is the whole read-back. Splicing a mutation's own response into
   * local state would show a row the Panel never read back from the Control
   * Plane (ADR-0036).
   */
  async function reread() {
    await router.invalidate();
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          {/* The Org shell frame owns the `h1` (the Organization); this screen is
              the Members section within it. */}
          <h2 className="font-semibold text-3xl text-foreground tracking-tight">Members</h2>
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">
            Who is in this Organization and what they may do here. Who can touch a specific
            App&apos;s configuration is managed under that App&apos;s Settings.
          </p>
        </div>
        <AddOrgMemberDialog actorRole={view.orgRole} onAdded={reread} orgId={view.orgId} />
      </div>

      {view.members.kind === "ready" ? (
        <OrgMembersTable
          actorRole={view.orgRole}
          actorUserId={view.userId}
          members={view.members.items}
          onChanged={reread}
          orgId={view.orgId}
        />
      ) : (
        <Alert
          data-testid={`members-${view.members.kind}`}
          variant={view.members.kind === "unavailable" ? "destructive" : "default"}
        >
          <AlertTitle>
            {view.members.kind === "locked"
              ? "Membership is not visible to you"
              : "Members unavailable"}
          </AlertTitle>
          <AlertDescription>{view.members.message}</AlertDescription>
        </Alert>
      )}

      <ParityNote hint={parityHint("organization_members_list")} />

      <SsoScimCard orgRole={view.orgRole} />
    </div>
  );
}
