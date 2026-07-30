import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";

/**
 * The session snapshot is capped, and this says so.
 *
 * The cap exists because a session principal that scales with membership count
 * can be grown until it can no longer be materialized, which locks a User out of
 * their own account. But a capped list that renders as if it were the whole list
 * is the "healthy because unknown" shape ADR-0036 forbids: a User would read a
 * missing Organization as deleted. So the truncation travels with the snapshot
 * and is stated wherever the snapshot is rendered.
 *
 * The remedy is deliberately NOT "open it by URL": every Panel route authorizes
 * against this same snapshot, so an Organization missing from it is unreachable
 * in the browser, and offering that link would be a retry that cannot succeed.
 * The CLI and MCP surfaces read the Control Plane directly and are not capped,
 * so that is the action named here.
 */
export function OrganizationsTruncatedNotice({ limit }: { limit: number }) {
  return (
    <Alert data-testid="organizations-truncated">
      <AlertTitle>Showing the first {limit} of your Organizations</AlertTitle>
      <AlertDescription>
        You belong to more Organizations than one sign-in session can carry, so this list is cut
        short. The rest still exist and nothing was deleted, but the Control Panel cannot reach them
        while they are outside this list. Run <code>splitch orgs list</code> or call{" "}
        <code>organizations_list</code> to see all of them.
      </AlertDescription>
    </Alert>
  );
}
