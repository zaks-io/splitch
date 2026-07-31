import { EnvironmentLink } from "#components/environment-link";
import { appAttentionSummary, environmentAttention, type OrgAppListApp } from "#lib/org-app-list";

/**
 * The card IS the Environment picker. The App name is a heading, not a link,
 * because everything below an App is `(appId, environmentId)`-scoped: a bare App
 * link would have to invent a default Environment, and prod is never a silent
 * destination.
 */
export function AppListCard({ app, orgSlug }: { app: OrgAppListApp; orgSlug: string }) {
  const summary = appAttentionSummary(app);
  const unavailable = app.attention.kind === "unavailable";

  return (
    <article
      className="grid content-start gap-4 rounded-xl border border-border bg-card p-5 shadow-xs"
      data-app-card={app.appSlug}
    >
      <header className="grid gap-1">
        <h3 className="font-semibold text-foreground text-lg tracking-tight">{app.appSlug}</h3>
        <p
          className={
            unavailable
              ? "font-medium text-amber-600 text-xs dark:text-amber-400"
              : "text-muted-foreground text-xs"
          }
          data-app-attention-summary={app.appSlug}
        >
          {summary}
          {unavailable && app.attention.kind === "unavailable" ? ` — ${app.attention.message}` : ""}
        </p>
      </header>

      <div className="grid gap-2">
        <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          Open an Environment
        </p>
        {app.environments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {app.environments.map((environment) => (
              <EnvironmentLink
                appSlug={app.appSlug}
                attention={environmentAttention(app.attention, environment.environmentId)}
                environment={environment}
                key={environment.environmentId}
                orgSlug={orgSlug}
              />
            ))}
          </div>
        ) : (
          // Every App is provisioned with dev + prod (ADR-0027), so zero
          // Environments is a broken App, not an empty one. Say so.
          <p className="text-destructive text-sm" role="alert">
            This App has no Environments. It cannot be opened until one exists.
          </p>
        )}
      </div>
    </article>
  );
}
