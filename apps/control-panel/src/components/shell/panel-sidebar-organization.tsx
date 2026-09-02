import { Link } from "@tanstack/react-router";
import { CreateOrganizationDialog } from "#components/organizations/create-organization-dialog";
import {
  panelSidebarActiveLinkClassName,
  panelSidebarLinkClassName,
} from "#components/shell/panel-sidebar-link-styles";
import { ShellMenu, ShellMenuLink } from "#components/shell/shell-menu";
import type { ScopeNavigation } from "#lib/shared/loader-context";

// Full document navigations, not client route changes: the new Organization is
// in a session cookie the server re-reads on load, and a failed resync leaves a
// durable marker that `/` reports with the chooser.
function enterOrganization(orgSlug: string) {
  globalThis.location.assign(`/${encodeURIComponent(orgSlug)}`);
}

function reportStaleSession() {
  globalThis.location.assign("/");
}

export function PanelSidebarOrganization({
  navigation,
  org,
  pinned = true,
}: {
  navigation: ScopeNavigation;
  org: { orgId: string; orgSlug: string };
  /**
   * App screens pin this section to the sidebar foot as the step-out
   * affordance; Org screens place it at the top as the primary nav.
   */
  pinned?: boolean;
}) {
  return (
    <nav
      aria-label="Organization sections"
      className={
        pinned ? "mt-auto grid gap-1 border-t border-border px-3 pt-3" : "grid gap-1 px-3 pt-3"
      }
    >
      {navigation.orgs.length > 1 ? (
        <ShellMenu direction={pinned ? "up" : "down"} label="Organization" value={org.orgSlug}>
          {navigation.orgs.map((candidate) => (
            <ShellMenuLink href={`/${encodeURIComponent(candidate.orgSlug)}`} key={candidate.orgId}>
              {candidate.orgSlug}
            </ShellMenuLink>
          ))}
        </ShellMenu>
      ) : (
        <div className="grid gap-0.5 px-2.5 py-1.5">
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            Organization
          </span>
          <span className="truncate text-sm font-medium">{org.orgSlug}</span>
        </div>
      )}
      {/* These authenticated loaders should run for the chosen destination, not on hover. */}
      <Link
        activeOptions={{ exact: true }}
        activeProps={{ className: panelSidebarActiveLinkClassName }}
        className={panelSidebarLinkClassName}
        params={{ orgSlug: org.orgSlug }}
        preload={false}
        to="/$orgSlug"
      >
        Apps
      </Link>
      <Link
        activeProps={{ className: panelSidebarActiveLinkClassName }}
        className={panelSidebarLinkClassName}
        params={{ orgSlug: org.orgSlug }}
        preload={false}
        to="/$orgSlug/members"
      >
        Members
      </Link>
      <Link
        activeProps={{ className: panelSidebarActiveLinkClassName }}
        className={panelSidebarLinkClassName}
        params={{ orgSlug: org.orgSlug }}
        preload={false}
        to="/$orgSlug/integrations"
      >
        Integrations
      </Link>
      <Link
        activeProps={{ className: panelSidebarActiveLinkClassName }}
        className={panelSidebarLinkClassName}
        params={{ orgSlug: org.orgSlug }}
        preload={false}
        to="/$orgSlug/billing"
      >
        Billing &amp; Usage
      </Link>
      <CreateOrganizationDialog
        className={panelSidebarLinkClassName}
        onCreated={enterOrganization}
        onStaleSession={reportStaleSession}
        variant="ghost"
      />
    </nav>
  );
}
