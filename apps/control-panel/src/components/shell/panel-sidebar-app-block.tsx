import { useRouterState } from "@tanstack/react-router";
import { AppSplitMark } from "#components/shared/app-split-mark";
import { PanelSidebarEnvironments } from "#components/shell/panel-sidebar-environments";
import { panelSidebarLinkClassName } from "#components/shell/panel-sidebar-link-styles";
import {
  RouterAnchor,
  ShellMenu,
  ShellMenuGroup,
  ShellMenuLink,
} from "#components/shell/shell-menu";
import type { ScopeNavigation } from "#lib/shared/loader-context";
import { appHomeHref, appSectionAtPathname, scopedHref } from "#lib/shell/app-shell-navigation";

type NavigationOrg = ScopeNavigation["orgs"][number];

export type ActiveSidebarApp = {
  appId: string;
  appSlug: string;
  env?: string;
};

export type PanelSidebarAppBlockProps = {
  app?: ActiveSidebarApp;
  currentOrg: NavigationOrg;
  orgSlug: string;
};

export function PanelSidebarAppBlock({ app, currentOrg, orgSlug }: PanelSidebarAppBlockProps) {
  const href = useRouterState({ select: (state) => state.location.href });
  const currentApp = app
    ? currentOrg.apps.find((candidate) => candidate.appId === app.appId)
    : undefined;
  if (app && !currentApp) {
    throw new Error("Panel sidebar App is missing from navigation");
  }

  if (!app) {
    return <PanelSidebarAppList currentOrg={currentOrg} orgSlug={orgSlug} />;
  }

  return (
    <div className="grid gap-2 px-3 pt-3">
      <ShellMenu summary={appSummary(app.appSlug)}>
        <ShellMenuGroup label="Apps">
          {currentOrg.apps.map((candidate) => (
            <ShellMenuLink
              href={appSwitcherHref(href, orgSlug, app, candidate)}
              key={candidate.appId}
            >
              {candidate.appSlug}
            </ShellMenuLink>
          ))}
        </ShellMenuGroup>
      </ShellMenu>

      {currentApp ? (
        <PanelSidebarEnvironments
          appSlug={app.appSlug}
          active={app.env}
          currentHref={href}
          environments={currentApp.environments}
          orgSlug={orgSlug}
        />
      ) : null}
    </div>
  );
}

/**
 * Keep App changes within the current Environment-scoped route branch so the
 * persistent shell is not replaced. Detail routes step back to their section
 * because their resource IDs do not belong to the destination App.
 */
function appSwitcherHref(
  currentHref: string,
  orgSlug: string,
  currentApp: ActiveSidebarApp,
  candidate: NavigationOrg["apps"][number],
): string {
  if (candidate.appId === currentApp.appId) return currentHref;
  if (!currentApp.env || candidate.environments.length === 0) {
    return appHomeHref({ orgSlug, appSlug: candidate.appSlug });
  }

  const environment =
    candidate.environments.find(({ env }) => env === currentApp.env) ??
    candidate.environments.at(0);
  if (!environment) {
    throw new Error("Panel sidebar App has no Environment for App switching");
  }
  const pathname = new URL(currentHref, "https://panel.splitch.dev").pathname;
  const section = appSectionAtPathname(pathname, {
    appSlug: currentApp.appSlug,
    env: currentApp.env,
  });
  return scopedHref({ orgSlug, appSlug: candidate.appSlug, env: environment.env }, section);
}

/**
 * Org screens have no active App, so instead of a chooser over dead space the
 * sidebar lists every App as a direct link to its home.
 */
function PanelSidebarAppList({
  currentOrg,
  orgSlug,
}: {
  currentOrg: NavigationOrg;
  orgSlug: string;
}) {
  return (
    <nav aria-label="Apps" className="grid gap-1 px-3 pt-5">
      <p className="px-2.5 pb-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        Apps
      </p>
      {currentOrg.apps.map((candidate) => (
        <RouterAnchor
          className={panelSidebarLinkClassName}
          href={appHomeHref({ orgSlug, appSlug: candidate.appSlug })}
          key={candidate.appId}
        >
          <span className="flex min-w-0 items-center gap-2">
            <AppSplitMark />
            <span className="truncate font-mono">{candidate.appSlug}</span>
          </span>
        </RouterAnchor>
      ))}
      {currentOrg.apps.length === 0 ? (
        <p className="px-2.5 py-1.5 text-muted-foreground text-sm">No Apps yet</p>
      ) : null}
    </nav>
  );
}

function appSummary(appSlug: string) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AppSplitMark />
      <span className="grid min-w-0 flex-1 gap-0.5 text-left">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          App
        </span>
        <span className="truncate text-base font-semibold tracking-tight">{appSlug}</span>
      </span>
      <span aria-hidden="true" className="text-muted-foreground group-open:rotate-180">
        ▾
      </span>
    </span>
  );
}
