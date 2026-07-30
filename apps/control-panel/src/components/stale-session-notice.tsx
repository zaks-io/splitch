import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";

/**
 * The Organization or App exists; the sign-in session that lists memberships
 * does not know about it yet.
 *
 * This is deliberately NOT phrased as a creation failure and deliberately does
 * NOT offer "try again": creating it again would collide with the handle/key
 * the User just took, which is a fail-loud-but-impossible-retry (ADR-0036,
 * SPL-203, SPL-205). The membership snapshot lives in the session, so signing
 * in again is the action that actually resolves it. Reloading would not: the
 * stale snapshot is what would be read back.
 */
export function StaleSessionNotice({
  resource,
  slug,
}: {
  resource: "Organization" | "App";
  slug: string;
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
        <Button
          render={<a href="/auth/logout">Sign in again to continue</a>}
          size="sm"
          variant="outline"
        />
      </AlertDescription>
    </Alert>
  );
}
