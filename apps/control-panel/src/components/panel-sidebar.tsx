import { PanelSidebarAppBlock, type ActiveSidebarApp } from "#components/panel-sidebar-app-block";
import { PanelSidebarOrganization } from "#components/panel-sidebar-organization";
import { PanelSidebarSections } from "#components/panel-sidebar-sections";
import { ShellMenuSignOut } from "#components/shell-menu";
import type { ScopeNavigation } from "#lib/loader-context";

export type PanelSidebarProps = {
  navigation: ScopeNavigation;
  org: { orgId: string; orgSlug: string };
  app?: { appId: string; appSlug: string; env?: string };
  userId: string;
};

export function PanelSidebar({ app, navigation, org, userId }: PanelSidebarProps) {
  const currentOrg = navigation.orgs.find((candidate) => candidate.orgId === org.orgId);
  if (!currentOrg) {
    throw new Error("Panel sidebar Organization is missing from navigation");
  }
  const activeApp: ActiveSidebarApp | undefined = app?.env
    ? { appId: app.appId, appSlug: app.appSlug, env: app.env }
    : undefined;
  const avatarLabel = userId.at(0);
  if (!avatarLabel) {
    throw new Error("Panel sidebar User ID is empty");
  }

  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground max-md:w-full max-md:border-r-0 max-md:border-b"
      data-panel-sidebar
    >
      <PanelSidebarAppBlock app={activeApp} currentOrg={currentOrg} orgSlug={org.orgSlug} />
      {activeApp ? <PanelSidebarSections app={activeApp} orgSlug={org.orgSlug} /> : null}
      <PanelSidebarOrganization navigation={navigation} org={org} />
      <div className="grid gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs">
            {avatarLabel}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{userId}</span>
          <ShellMenuSignOut className="text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
            Sign out
          </ShellMenuSignOut>
        </div>
      </div>
    </aside>
  );
}
