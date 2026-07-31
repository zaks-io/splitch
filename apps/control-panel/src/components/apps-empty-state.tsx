import { EmptyState } from "@splitch/ui/state/empty-state";
import { CreateAppDialog } from "#components/create-app-dialog";
import { canCreateApp } from "#lib/org-app-list";
import type { OrgRole } from "#lib/session";

/**
 * Onboarding step 1's teaching surface: the App→Environment→Flag one-liner, one
 * primary action, and the CLI/agent equivalent. Every first-run empty surface
 * carries all three (screen-inventory.md).
 */
export function AppsEmptyState({ orgId, orgRole }: { orgId: string; orgRole: OrgRole }) {
  return (
    <EmptyState
      action={<CreateAppDialog orgId={orgId} orgRole={orgRole} />}
      className="min-h-72"
      description={
        <span>
          An App holds your Flags and Experiments and spans Environments. Creating one provisions{" "}
          <code>dev</code> and <code>prod</code>, and you add your first Flag inside an Environment.
          {canCreateApp(orgRole) ? (
            <>
              {" "}
              Prefer your terminal or agent? Run <code>splitch apps create</code> or call{" "}
              <code>apps_create</code>.
            </>
          ) : (
            <> Ask an Organization owner or admin to create the first App.</>
          )}
        </span>
      }
      title="Create your first App"
    />
  );
}
