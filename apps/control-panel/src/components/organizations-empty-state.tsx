import { EmptyState } from "@splitch/ui/state/empty-state";
import { CreateOrganizationDialog } from "#components/create-organization-dialog";

/**
 * The first screen a User with no memberships sees. It teaches what an
 * Organization is in splitch's model before asking for one, and carries the
 * CLI/agent equivalent, the way every first-run empty surface does
 * (screen-inventory.md).
 */
export function OrganizationsEmptyState({
  onCreated,
  onStaleSession,
}: {
  onCreated: (orgSlug: string) => void;
  onStaleSession: (orgSlug: string) => void;
}) {
  return (
    <EmptyState
      action={
        <CreateOrganizationDialog
          label="Create your Organization"
          onCreated={onCreated}
          onStaleSession={onStaleSession}
        />
      }
      className="min-h-72"
      description={
        <span>
          An Organization is the outermost boundary in splitch: it owns your Apps, your teammates,
          and your billing, and nothing is shared across two of them. You create one, then an App
          inside it, then Flags inside that App's Environments.{" "}
          <span className="block pt-2">
            Prefer your terminal or agent? Run <code>splitch orgs create</code> or call{" "}
            <code>organizations_create</code>.
          </span>
        </span>
      }
      title="Create your first Organization"
    />
  );
}
