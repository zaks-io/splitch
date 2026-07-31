import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { SignOutForm } from "#components/sign-out-form";

/**
 * The Organization or App exists; the sign-in session that lists memberships
 * does not know about it yet.
 *
 * This is deliberately NOT phrased as a creation failure and deliberately does
 * NOT offer "try again": creating it again would collide with the handle/key
 * the User just took, which is a fail-loud-but-impossible-retry (ADR-0036,
 * SPL-203, SPL-205).
 *
 * The remedy is NOT always "sign in again". Signing in re-runs the exact
 * `buildSessionPrincipal` call that just threw, so it only resolves the two
 * failure modes about the session's own identity (`remedy: "reauth"`,
 * classified in `resync-remedy.ts`). For everything else — a D1 or KV outage,
 * a corrupt membership row — re-authenticating reproduces the identical
 * throw during the callback, and `/auth/logout` destroys the working session
 * to get there. Offering it unconditionally would relocate the exact
 * impossible-remedy shape this ticket fixes from the create form to this
 * notice, so the two remedies never share a branch, and the reason from the
 * Control Plane is always shown rather than left implicit (ADR-0036).
 */
export function StaleSessionNotice({
  resource,
  slug,
  reason,
  remedy,
}: {
  resource: "Organization" | "App";
  slug: string;
  reason: string;
  remedy: "reauth" | "retry";
}) {
  const identifier = resource === "Organization" ? "handle" : "key";
  return (
    <Alert data-testid={`${resource === "Organization" ? "organization" : "app"}-session-stale`}>
      <AlertTitle>
        {resource} "{slug}" was created
      </AlertTitle>
      <AlertDescription className="grid gap-3">
        <span>
          It is saved and the {identifier} is yours. Your sign-in session still holds the membership
          list from before you created it, so it is not in the list below yet. Do not create it
          again — the {identifier} is already taken by this {resource}.
        </span>
        <span className="text-muted-foreground text-xs" data-testid="session-stale-reason">
          The Control Plane said: {reason}
        </span>
        {remedy === "reauth" ? (
          <SignOutForm>
            <Button data-testid="session-stale-reauth" size="sm" type="submit" variant="outline">
              Sign in again to continue
            </Button>
          </SignOutForm>
        ) : (
          <Button
            data-testid="session-stale-reload"
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
