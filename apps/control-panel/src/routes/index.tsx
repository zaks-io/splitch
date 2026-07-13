import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import type { SessionPrincipal } from "#lib/session";
import { loadCurrentSession } from "#lib/session-functions";
import { createFileRoute, redirect } from "@tanstack/react-router";

const service = "splitch-control-panel";

export const Route = createFileRoute("/")({
  loader: async ({ location }): Promise<SessionPrincipal> => {
    const result = await loadCurrentSession();
    if (result.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    return result.session;
  },
  component: IndexRoute,
});

function IndexRoute() {
  const session = Route.useLoaderData();

  return (
    <main className="grid gap-6">
      <section className="grid gap-4">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{service}</p>
        <div className="grid gap-2">
          <h1 className="font-semibold text-3xl text-foreground">Control Panel</h1>
          <p className="max-w-2xl text-base text-muted-foreground">
            App and Environment scoped authoring for feature flags and A/B experimentation.
          </p>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Organizations</CardTitle>
          <CardDescription>{session.userId}</CardDescription>
        </CardHeader>

        <CardContent className="grid gap-5">
          {session.orgs.length > 0 ? (
            <div className="grid gap-3">
              {session.orgs.map((org) => (
                <section
                  className="rounded-md border border-border p-4"
                  key={org.orgId}
                  data-org-slug={org.orgSlug}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="grid gap-1">
                      <h2 className="font-semibold text-foreground text-lg">{org.orgSlug}</h2>
                      <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
                        {org.orgRole}
                      </p>
                    </div>
                    <Button render={<a href="/auth/logout">Sign out</a>} variant="outline" />
                  </div>
                  {org.apps.length > 0 ? (
                    <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {org.apps.map((app) => (
                        <div className="rounded-md bg-muted p-3" key={app.appId}>
                          <dt className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
                            {app.role}
                          </dt>
                          <dd className="font-medium text-foreground text-sm">{app.appSlug}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </section>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No organization memberships.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function loginRedirect(returnTo: string): ReturnType<typeof redirect> {
  return redirect({
    href: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  });
}
