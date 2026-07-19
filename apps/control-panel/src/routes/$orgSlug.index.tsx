import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { loadOrgNavigation } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/")({
  loader: async ({ location, params }) => {
    const result = await loadOrgNavigation({ data: params.orgSlug });
    if (result.kind === "unauthenticated") {
      throw redirect({ href: `/auth/login?returnTo=${encodeURIComponent(location.href)}` });
    }
    return result.kind === "ok" ? result.organization : null;
  },
  component: OrganizationRoute,
});

function OrganizationRoute() {
  const organization = Route.useLoaderData();
  if (!organization) {
    return (
      <Alert className="mx-auto max-w-xl" variant="destructive">
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>You are not a member of this Organization.</AlertDescription>
      </Alert>
    );
  }

  return (
    <main className="grid gap-6">
      <header className="grid gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
          Organization
        </p>
        <h1 className="font-semibold text-3xl text-foreground">{organization.orgSlug}</h1>
        <p className="text-muted-foreground">Choose an App and Environment.</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2" aria-label="Apps">
        {organization.apps.map((app) => (
          <Card key={app.appId}>
            <CardHeader>
              <CardTitle>{app.appSlug}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {app.environments.map((environment) => (
                <Link
                  className="rounded-md border border-border px-3 py-2 font-medium text-sm hover:bg-accent"
                  key={environment.environmentId}
                  params={{
                    appSlug: app.appSlug,
                    env: environment.env,
                    orgSlug: organization.orgSlug,
                  }}
                  to="/$orgSlug/$appSlug/$env"
                >
                  {environment.name}
                </Link>
              ))}
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
