import { AppsEmptyState } from "#components/apps-empty-state";
import { HomeAppsTable } from "#components/home-apps-table";
import { HomeContinueCard } from "#components/home-continue-card";
import { HomeNeedsYou } from "#components/home-needs-you";
import { ProvisionalOrgBanner } from "#components/provisional-org-banner";
import { StaleSessionNotice } from "#components/stale-session-notice";
import { needsYouItems } from "#lib/home-needs-you";
import type { OrgAppListView } from "#lib/org-app-list";

/** The Organization Home: Continue, Apps, and Experiment health requiring attention. */
export function HomePage({ view }: { view: OrgAppListView }) {
  const hasApps = view.apps.length > 0 || view.pendingAppResync !== null;
  const needsYou = needsYouItems(view);

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

      {view.lastVisited ? <HomeContinueCard entry={view.lastVisited} now={view.now} /> : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {hasApps ? (
            <HomeAppsTable view={view} />
          ) : (
            <AppsEmptyState orgId={view.orgId} orgRole={view.orgRole} />
          )}
        </div>
        <div className="lg:col-span-2">
          <HomeNeedsYou items={needsYou} />
        </div>
      </div>
    </div>
  );
}
