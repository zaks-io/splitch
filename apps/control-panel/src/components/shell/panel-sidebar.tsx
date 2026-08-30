import { BrandMark } from "@splitch/ui/components/brand-mark";
import {
  type ActiveSidebarApp,
  PanelSidebarAppBlock,
} from "#components/shell/panel-sidebar-app-block";
import { PanelSidebarOrganization } from "#components/shell/panel-sidebar-organization";
import { PanelSidebarPaletteTrigger } from "#components/shell/panel-sidebar-palette-trigger";
import { PanelSidebarSections } from "#components/shell/panel-sidebar-sections";
import { ShellMenuSignOut } from "#components/shell/shell-menu";
import type { ScopeNavigation } from "#lib/shared/loader-context";

export type PanelSidebarProps = {
  navigation: ScopeNavigation;
  org: { orgId: string; orgSlug: string };
  app?: { appId: string; appSlug: string; env?: string };
  userId: string;
  onOpenPalette: () => void;
};

export function PanelSidebar({ app, navigation, onOpenPalette, org, userId }: PanelSidebarProps) {
  const currentOrg = navigation.orgs.find((candidate) => candidate.orgId === org.orgId);
  if (!currentOrg) {
    throw new Error("Panel sidebar Organization is missing from navigation");
  }
  const activeApp: ActiveSidebarApp | undefined = app;
  const avatarLabel = userId.at(0);
  if (!avatarLabel) {
    throw new Error("Panel sidebar User ID is empty");
  }

  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground max-md:w-full max-md:border-r-0 max-md:border-b"
      data-panel-sidebar
    >
      <a
        aria-label="splitch home"
        className="flex items-center border-b border-border px-5.5 py-3"
        href="/"
      >
        <BrandMark className="text-lg" />
      </a>
      {activeApp ? (
        <>
          <PanelSidebarAppBlock app={activeApp} currentOrg={currentOrg} orgSlug={org.orgSlug} />
          {activeApp.env ? (
            <PanelSidebarSections
              app={{ ...activeApp, env: activeApp.env }}
              orgSlug={org.orgSlug}
            />
          ) : null}
          <PanelSidebarOrganization navigation={navigation} org={org} />
        </>
      ) : (
        <>
          <PanelSidebarOrganization navigation={navigation} org={org} pinned={false} />
          <PanelSidebarAppBlock currentOrg={currentOrg} orgSlug={org.orgSlug} />
        </>
      )}
      <div className={activeApp ? "grid gap-2 p-3" : "mt-auto grid gap-2 p-3"}>
        <PanelSidebarPaletteTrigger onOpen={onOpenPalette} />
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs">
            {avatarLabel}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
            {userId}
          </span>
          <ShellMenuSignOut className="text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
            Sign out
          </ShellMenuSignOut>
        </div>
      </div>
    </aside>
  );
}
