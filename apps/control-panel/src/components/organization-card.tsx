import { ProvisionalOrgBanner } from "#components/provisional-org-banner";
import type { OrgMembership } from "#lib/session";

/** One entry in the Organization chooser: the Organization plus its Apps at a glance. */
export function OrganizationCard({ org }: { org: OrgMembership }) {
  return (
    <div className="grid gap-2" data-org-slug={org.orgSlug}>
      {org.isProvisional && org.demoExpiresAt ? (
        <ProvisionalOrgBanner
          claimHref={`/${encodeURIComponent(org.orgSlug)}/claim`}
          demoExpiresAt={org.demoExpiresAt}
        />
      ) : null}
      <a
        className="grid content-start gap-3 rounded-xl border border-border bg-card p-5 shadow-xs transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        href={`/${encodeURIComponent(org.orgSlug)}`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold text-foreground text-lg tracking-tight">
            {org.orgSlug}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            {org.orgRole}
          </span>
        </span>
        <AppSummary apps={org.apps} />
      </a>
    </div>
  );
}

function AppSummary({ apps }: { apps: OrgMembership["apps"] }) {
  if (apps.length === 0) {
    return <span className="text-muted-foreground text-xs">No Apps yet</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {apps.map((app) => (
        <span
          className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
          key={app.appId}
        >
          {app.appSlug}
        </span>
      ))}
    </span>
  );
}
