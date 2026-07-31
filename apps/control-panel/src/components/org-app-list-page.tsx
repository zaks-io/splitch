import { AppListCard } from "#components/app-list-card";
import { AppsEmptyState } from "#components/apps-empty-state";
import { CreateAppDialog } from "#components/create-app-dialog";
import { ProvisionalOrgBanner } from "#components/provisional-org-banner";
import { StaleSessionNotice } from "#components/stale-session-notice";
import type { OrgAppListView } from "#lib/org-app-list";

/** The Org landing screen: `/{orgSlug}`. Apps for this Organization only. */
export function OrgAppListPage({ view }: { view: OrgAppListView }) {
  // A pending resync means an App exists that this read cannot see yet
  // (SPL-203): `apps` is a prefix of the truth, not the whole of it, so the
  // empty state below must not say "Create your first App" — the key it
  // would suggest is already taken.
  const hasApps = view.apps.length > 0 || view.pendingAppResync !== null;

  return (
    <div className="grid gap-6">
      {view.isProvisional && view.demoExpiresAt ? (
        <ProvisionalOrgBanner
          claimHref={`/${encodeURIComponent(view.orgSlug)}/claim`}
          demoExpiresAt={view.demoExpiresAt}
        />
      ) : null}

      {view.pendingAppResync ? (
        <StaleSessionNotice
          reason={view.pendingAppResync.reason}
          remedy={view.pendingAppResync.remedy}
          resource="App"
          slug={view.pendingAppResync.appSlug}
        />
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          {/* The Org shell frame owns the `h1` (the Organization); this screen is
              the Apps section within it. */}
          <h2 className="font-semibold text-3xl text-foreground tracking-tight">Apps</h2>
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">
            Each card is an Environment picker. Pick the Environment you mean to work in — there is
            no default, so production is never where you land by accident.
          </p>
        </div>
        {hasApps ? <CreateAppDialog orgId={view.orgId} orgRole={view.orgRole} /> : null}
      </div>

      {view.apps.length > 0 ? (
        <section aria-label="Apps" className="grid gap-4 sm:grid-cols-2">
          {view.apps.map((app) => (
            <AppListCard app={app} key={app.appId} orgSlug={view.orgSlug} />
          ))}
        </section>
      ) : null}

      {hasApps ? null : <AppsEmptyState orgId={view.orgId} orgRole={view.orgRole} />}
    </div>
  );
}
