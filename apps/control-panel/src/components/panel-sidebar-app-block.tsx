import { useRouterState } from "@tanstack/react-router";
import { AppSplitMark } from "#components/app-split-mark";
import { panelSidebarLinkClassName } from "#components/panel-sidebar-link-styles";
import { RouterAnchor, ShellMenu, ShellMenuGroup, ShellMenuLink } from "#components/shell-menu";
import { appHomeHref, environmentSwitchHref, scopedHref } from "#lib/app-shell-navigation";
import type { ScopeNavigation } from "#lib/loader-context";
import { EnvironmentWarningDot } from "./environment-warning-dot";

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
              href={appHomeHref({ orgSlug, appSlug: candidate.appSlug })}
              key={candidate.appId}
            >
              {candidate.appSlug}
            </ShellMenuLink>
          ))}
        </ShellMenuGroup>
      </ShellMenu>

      {currentApp ? (
        <div className="flex flex-wrap items-center gap-1 px-1.5">
          <span className="mr-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            Environment
          </span>
          {currentApp.environments.map((environment) => {
            const active = environment.env === app.env;
            const stateClassName = active
              ? environment.guarded
                ? "bg-warning-muted text-warning-foreground ring-1 ring-warning/40"
                : "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground";
            return (
              <RouterAnchor
                className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${stateClassName}`}
                data-environment-pill={environment.env}
                href={environmentPillHref(href, orgSlug, app, environment.env)}
                key={environment.environmentId}
                title={environment.name}
              >
                {environment.guarded ? <EnvironmentWarningDot /> : null}
                {environment.env}
              </RouterAnchor>
            );
          })}
        </div>
      ) : null}
    </div>
  );
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

/**
 * From an Environment-scoped page the pill keeps the section, search, and hash;
 * from App home (no Environment) it opens that Environment's Flags.
 */
function environmentPillHref(
  currentHref: string,
  orgSlug: string,
  app: ActiveSidebarApp,
  nextEnv: string,
): string {
  return app.env
    ? environmentSwitchHref(currentHref, { orgSlug, appSlug: app.appSlug, env: app.env }, nextEnv)
    : scopedHref({ orgSlug, appSlug: app.appSlug, env: nextEnv }, "flags");
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
