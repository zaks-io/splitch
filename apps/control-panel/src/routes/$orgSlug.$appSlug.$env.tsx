import { surfaceClassName } from "@splitch/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$orgSlug/$appSlug/$env")({
  component: ScopePlaceholderRoute,
});

function ScopePlaceholderRoute() {
  const params = Route.useParams();

  return (
    <main className="grid gap-6">
      <section className="grid gap-2">
        <p className="font-mono text-neutral-500 text-xs uppercase tracking-wide">Scope</p>
        <h1 className="font-semibold text-3xl text-neutral-900">App scope preview</h1>
      </section>

      <dl
        className={`${surfaceClassName} grid gap-4 border-neutral-200 bg-neutral-0 sm:grid-cols-3`}
      >
        <ScopeValue label="Organization" value={params.orgSlug} />
        <ScopeValue label="App" value={params.appSlug} />
        <ScopeValue label="Environment" value={params.env} />
      </dl>
    </main>
  );
}

function ScopeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-neutral-500 text-xs uppercase tracking-wide">{label}</dt>
      <dd className="font-medium text-neutral-900 text-sm">{value}</dd>
    </div>
  );
}
