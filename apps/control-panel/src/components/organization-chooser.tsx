import { useEffect, useState } from "react";
import { CreateOrganizationDialog } from "#components/create-organization-dialog";
import { OrganizationCard } from "#components/organization-card";
import { OrganizationsEmptyState } from "#components/organizations-empty-state";
import { OrganizationsTruncatedNotice } from "#components/organizations-truncated-notice";
import { StaleSessionNotice } from "#components/stale-session-notice";
import type { OrgMembership } from "#lib/session";
import type { StaleSession } from "#lib/stale-session";

/**
 * The root landing screen. It is a chooser, not a redirect: a single-org user
 * still sees which Organization they are entering, so the scope they are about to
 * work in is never picked for them behind the URL. Each entry navigates to that
 * Organization's App list, which is the only way into an App.
 *
 * With zero memberships it is the sign-up surface rather than a dead end: a User
 * who just signed in has nothing to be a member of yet, so the only useful thing
 * this screen can do is teach what an Organization is and create one (SPL-205).
 */
export function OrganizationChooser({
  orgs,
  pendingResync = null,
  truncated = false,
}: {
  orgs: readonly OrgMembership[];
  /**
   * The durable, server-read half of the notice (SPL-203 review round 2): set
   * when a create's resync failed and has not yet been resolved by a retry on
   * a later load, so the notice survives navigation and a reload rather than
   * disappearing the moment `staleOrg` below is reset.
   */
  pendingResync?: StaleSession | null;
  /** The snapshot is a prefix, not the whole set. Stated, never implied. */
  truncated?: boolean;
}) {
  const [staleOrg, setStaleOrg] = useState<StaleSession | null>(null);
  // The local state is fresher when both are set: it is written the instant a
  // create settles, before this load's `pendingResync` could possibly know
  // about it.
  const notice = staleOrg ?? pendingResync;
  // Create Organization is server-driven and inert until hydration, so the
  // screen publishes when it is actually usable rather than leaving a
  // rendered-but-dead control (the same contract the Org and App shells publish).
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);

  // A full document navigation, not a client route change: the Organization the
  // User just created is in a session cookie the server re-reads on load.
  function enterOrganization(orgSlug: string) {
    globalThis.location.assign(`/${encodeURIComponent(orgSlug)}`);
  }

  return (
    <div
      className="grid gap-4"
      data-hydrated={isHydrated ? "true" : "false"}
      data-org-chooser="ready"
    >
      {notice ? (
        <StaleSessionNotice
          reason={notice.reason}
          remedy={notice.remedy}
          resource="Organization"
          slug={notice.slug}
        />
      ) : null}
      {truncated ? <OrganizationsTruncatedNotice limit={orgs.length} /> : null}
      {orgs.length === 0 ? (
        <OrganizationsEmptyState onCreated={enterOrganization} onStaleSession={setStaleOrg} />
      ) : (
        <>
          <section aria-label="Organizations" className="grid gap-3 sm:grid-cols-2">
            {orgs.map((org) => (
              <OrganizationCard key={org.orgId} org={org} />
            ))}
          </section>
          <div>
            <CreateOrganizationDialog
              label="Create Organization"
              onCreated={enterOrganization}
              onStaleSession={setStaleOrg}
              variant="outline"
            />
          </div>
        </>
      )}
    </div>
  );
}
