import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env")({
  component: ScopePlaceholderRoute,
});

function ScopePlaceholderRoute() {
  const params = Route.useParams();

  return (
    <main className="grid gap-6">
      <section className="grid gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">Scope</p>
        <h1 className="font-semibold text-3xl text-foreground">App scope preview</h1>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>URL scope</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            <ScopeValue label="Organization" value={params.orgSlug} />
            <ScopeValue label="App" value={params.appSlug} />
            <ScopeValue label="Environment" value={params.env} />
          </dl>
        </CardContent>
      </Card>
    </main>
  );
}

function ScopeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="font-medium text-foreground text-sm">{value}</dd>
    </div>
  );
}
