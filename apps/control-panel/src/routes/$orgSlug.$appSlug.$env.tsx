import { Button } from "@splitch/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { AccessDeniedPage } from "@splitch/ui/state/access-denied-page";
import { AppErrorPage } from "@splitch/ui/state/app-error-page";
import { NotFoundPage } from "@splitch/ui/state/not-found-page";
import {
  AccessDeniedError,
  isAccessDeniedError,
  type ScopedLoaderContext,
} from "#lib/loader-context";
import { loadScopedSession } from "#lib/session-functions";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env")({
  loader: async ({ location, params }): Promise<ScopedLoaderContext> => {
    const result = await loadScopedSession({ data: params });
    if (result.kind === "unauthenticated") {
      throw loginRedirect(`${location.pathname}${location.search}${location.hash}`);
    }
    if (result.kind === "forbidden") {
      throw new AccessDeniedError();
    }
    if (result.kind === "notFound") {
      throw notFound();
    }
    return result.context;
  },
  errorComponent: ({ error }) => {
    if (isAccessDeniedError(error)) {
      return (
        <AccessDeniedPage
          action={<Button render={<a href="/">Home</a>} variant="outline" />}
          description="You do not have access to this scope."
          title="Access denied"
        />
      );
    }
    return <AppErrorPage description="Refresh the page or try again later." />;
  },
  notFoundComponent: () => (
    <NotFoundPage description="The requested Environment was not found in this App." />
  ),
  component: ScopePlaceholderRoute,
});

function ScopePlaceholderRoute() {
  const context = Route.useLoaderData();

  return (
    <main className="grid gap-6">
      <section className="grid gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">Scope</p>
        <h1 className="font-semibold text-3xl text-foreground">App scope preview</h1>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Resolved scope</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            <ScopeValue label="Organization" value={context.scope.orgSlug} />
            <ScopeValue label="App" value={context.scope.appSlug} />
            <ScopeValue label="Environment" value={context.scope.env} />
            <ScopeValue label="Organization role" value={context.scope.orgRole} />
            <ScopeValue label="App role" value={context.scope.appRole} />
            <ScopeValue label="Environment ID" value={context.scope.environmentId} />
          </dl>
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

function ScopeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="font-medium text-foreground text-sm">{value}</dd>
    </div>
  );
}
