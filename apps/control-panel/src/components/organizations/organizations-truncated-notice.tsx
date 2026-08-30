import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  ORGANIZATIONS_TRUNCATED_DESCRIPTION,
  organizationsTruncatedTitle,
} from "#lib/organizations/organizations-truncated";
import { parityHint } from "#lib/connect/parity-hints";
import { ParityNote } from "#components/connect/parity-note";

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
 * so that is the action named here, derived from the route registry rather than
 * typed out, so a command the shipped skins do not answer to cannot render.
 */
export function OrganizationsTruncatedNotice({ limit }: { limit: number }) {
  return (
    <Alert data-testid="organizations-truncated">
      <AlertTitle>{organizationsTruncatedTitle(limit)}</AlertTitle>
      <AlertDescription>
        {ORGANIZATIONS_TRUNCATED_DESCRIPTION} To see all of them:{" "}
        <ParityNote hint={parityHint("organizations_list")} />
      </AlertDescription>
    </Alert>
  );
}
