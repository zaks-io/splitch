import type { App } from "@splitch/contracts";
import { Card, CardDescription, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { AppIdentityForm } from "./app-identity-form";
import { AppIdentityReadOnly } from "./app-identity-read-only";

const SLUG_HELP =
  "Appears in every URL for this App. Unique within the Organization. Changing it breaks links and bookmarks built from the old one.";

/**
 * The App's name and URL slug. Owners and Admins get the form; everyone else
 * gets the same two facts stated plainly, because the App role matrix makes
 * rename an admin write and the Worker rechecks that on every call.
 */
export function AppIdentityCard({
  app,
  canRename,
  env,
  orgSlug,
}: {
  app: App;
  canRename: boolean;
  /** The two URL segments a slug change does NOT move, so the new URL can be built. */
  env: string;
  orgSlug: string;
}) {
  return (
    <Card data-testid="app-identity-card">
      <CardHeader>
        <CardTitle>App</CardTitle>
        <CardDescription>
          What this App is called, and the handle every URL for it is built from.
        </CardDescription>
      </CardHeader>
      {canRename ? (
        <AppIdentityForm app={app} env={env} orgSlug={orgSlug} slugHelp={SLUG_HELP} />
      ) : (
        <AppIdentityReadOnly app={app} slugHelp={SLUG_HELP} />
      )}
    </Card>
  );
}
