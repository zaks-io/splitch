import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { SignOutForm } from "#components/sessions/sign-out-form";

/**
 * The App WAS renamed or deleted; the sign-in session that lists your Apps still
 * holds the state from before.
 *
 * Never phrased as a failed mutation and never offering "try again": the change
 * already committed, and retrying it would either collide with the slug the
 * operator just took or delete an App that is already gone (ADR-0036, SPL-203).
 *
 * The remedy is not always "sign in again" — that re-runs the exact call that
 * just threw, so it only fixes the failures about the session's own identity
 * (`resync-remedy.ts`). For a D1 or KV outage it would trade a stale but working
 * session for a dead one, so the two remedies never share a branch.
 */
export function AppSessionStaleNotice({
  appName,
  outcome,
  reason,
  remedy,
}: {
  appName: string;
  outcome: "renamed" | "deleted";
  reason: string;
  remedy: "reauth" | "retry";
}) {
  return (
    <Alert data-testid="app-session-stale">
      <AlertTitle>
        {appName} was {outcome}
      </AlertTitle>
      <AlertDescription className="grid gap-3">
        <span>
          The change is saved. Your sign-in session still lists this App the way it was, so
          navigation elsewhere in the Panel will be wrong until the session catches up. Do not{" "}
          {outcome === "renamed" ? "rename it again" : "delete it again"}.
        </span>
        <span className="text-muted-foreground text-xs" data-testid="app-session-stale-reason">
          The Control Plane said: {reason}
        </span>
        {remedy === "reauth" ? (
          <SignOutForm>
            <Button
              data-testid="app-session-stale-reauth"
              size="sm"
              type="submit"
              variant="outline"
            >
              Sign in again to continue
            </Button>
          </SignOutForm>
        ) : (
          <Button
            data-testid="app-session-stale-reload"
            onClick={() => globalThis.location.reload()}
            size="sm"
            type="button"
            variant="outline"
          >
            Reload to check again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
