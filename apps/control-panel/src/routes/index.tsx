import { Button } from "@splitch/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { OrganizationChooser } from "#components/organization-chooser";
import { SignOutForm } from "#components/sign-out-form";
import { loginRedirect } from "#lib/login-redirect";
import type { SessionPrincipal } from "#lib/session";
import { loadCurrentSession } from "#lib/session-functions";
import type { StaleSession } from "#lib/stale-session";

export interface IndexLoaderData {
  session: SessionPrincipal;
  pendingOrgResync: StaleSession | null;
}

export const Route = createFileRoute("/")({
  loader: async ({ location }): Promise<IndexLoaderData> => {
    const result = await loadCurrentSession();
    if (result.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    return { session: result.session, pendingOrgResync: result.pendingOrgResync };
  },
  component: IndexRoute,
});

function IndexRoute() {
  const { session, pendingOrgResync } = Route.useLoaderData();

  return (
    <main className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <h1 className="font-semibold text-3xl text-foreground tracking-tight">Control Panel</h1>
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">
            {session.orgs.length === 0
              ? "Every App, Flag, and Experiment belongs to an Organization, so that is the first thing to make."
              : "Choose an Organization to see its Apps. Flags and Experiments live inside an App's Environments."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground text-xs">
            Signed in as <span className="font-mono text-foreground">{session.userId}</span>
          </p>
          <SignOutForm>
            <Button size="sm" type="submit" variant="outline">
              Sign out
            </Button>
          </SignOutForm>
        </div>
      </header>

      <OrganizationChooser
        orgs={session.orgs}
        pendingResync={pendingOrgResync}
        truncated={session.orgsTruncated ?? false}
      />
    </main>
  );
}
