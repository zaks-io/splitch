import { AppsEmptyState } from "#components/apps/apps-empty-state";
import { HomeAppsTable } from "#components/home/home-apps-table";
import { HomeContinueCard } from "#components/home/home-continue-card";
import { HomeNeedsYou } from "#components/home/home-needs-you";
import { ProvisionalOrgBanner } from "#components/organizations/provisional-org-banner";
import { StaleSessionNotice } from "#components/sessions/stale-session-notice";
import { needsYouEmptyCopy, needsYouItems, needsYouMeasuredClear } from "#lib/home/home-needs-you";
import type { OrgAppListView } from "#lib/organizations/org-app-list";

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
          <HomeNeedsYou
            emptyCopy={needsYouEmptyCopy(view)}
            items={needsYou}
            measuredClear={needsYouMeasuredClear(view)}
          />
        </div>
      </div>
    </div>
  );
}
