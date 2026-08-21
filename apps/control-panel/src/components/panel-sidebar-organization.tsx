import { Link } from "@tanstack/react-router";
import {
  panelSidebarActiveLinkClassName,
  panelSidebarLinkClassName,
} from "#components/panel-sidebar-link-styles";
import { ShellMenu, ShellMenuLink } from "#components/shell-menu";
import type { ScopeNavigation } from "#lib/loader-context";

export function PanelSidebarOrganization({
  navigation,
  org,
}: {
  navigation: ScopeNavigation;
  org: { orgId: string; orgSlug: string };
}) {
  return (
    <nav
      aria-label="Organization sections"
      className="mt-auto grid gap-1 border-t border-border px-3 pt-3"
    >
      {navigation.orgs.length > 1 ? (
        <ShellMenu direction="up" label="Organization" value={org.orgSlug}>
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
      <Link
        activeOptions={{ exact: true }}
        activeProps={{ className: panelSidebarActiveLinkClassName }}
        className={panelSidebarLinkClassName}
        params={{ orgSlug: org.orgSlug }}
        to="/$orgSlug"
      >
        Apps
      </Link>
      <Link
        activeProps={{ className: panelSidebarActiveLinkClassName }}
        className={panelSidebarLinkClassName}
        params={{ orgSlug: org.orgSlug }}
        to="/$orgSlug/members"
      >
        Members
      </Link>
      <Link
        activeProps={{ className: panelSidebarActiveLinkClassName }}
        className={panelSidebarLinkClassName}
        params={{ orgSlug: org.orgSlug }}
        to="/$orgSlug/billing"
      >
        Billing &amp; Usage
      </Link>
    </nav>
  );
}
