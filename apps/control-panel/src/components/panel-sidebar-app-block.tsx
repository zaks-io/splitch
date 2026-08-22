import { useRouterState } from "@tanstack/react-router";
import { RouterAnchor, ShellMenu, ShellMenuGroup, ShellMenuLink } from "#components/shell-menu";
import {
  appSectionRegistry,
  destinationSection,
  environmentSwitchHref,
  scopedHref,
  type UrlScope,
} from "#lib/app-shell-navigation";
import type { ScopeNavigation } from "#lib/loader-context";

type NavigationOrg = ScopeNavigation["orgs"][number];

export type ActiveSidebarApp = {
  appId: string;
  appSlug: string;
  env: string;
};

export type PanelSidebarAppBlockProps = {
  app?: ActiveSidebarApp;
  currentOrg: NavigationOrg;
  orgSlug: string;
};

const SECTION_KEYS = new Set(
  appSectionRegistry.map((destination) => destinationSection(destination.to)),
);

export function PanelSidebarAppBlock({ app, currentOrg, orgSlug }: PanelSidebarAppBlockProps) {
  const href = useRouterState({ select: (state) => state.location.href });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentApp = app
    ? currentOrg.apps.find((candidate) => candidate.appId === app.appId)
    : undefined;
  if (app && !currentApp) {
    throw new Error("Panel sidebar App is missing from navigation");
  }
  const scope = app ? { orgSlug, appSlug: app.appSlug, env: app.env } : undefined;
  const currentSection = scope ? sectionAt(pathname, scope) : "";

  return (
    <div className="grid gap-2 px-3 pt-3">
      <ShellMenu summary={appSummary(app?.appSlug)}>
        <ShellMenuGroup label="Apps">
          {currentOrg.apps.map((candidate) => (
            <ShellMenuLink
              href={appHref(candidate, orgSlug, app?.env, currentSection)}
              key={candidate.appId}
            >
              {candidate.appSlug}
            </ShellMenuLink>
          ))}
        </ShellMenuGroup>
      </ShellMenu>

      {scope && currentApp ? (
        <div className="flex flex-wrap items-center gap-1 px-1.5">
          <span className="mr-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            Environment
          </span>
          {currentApp.environments.map((environment) => {
            const active = environment.env === scope.env;
            const stateClassName = active
              ? environment.guarded
                ? "bg-warning-muted text-warning-foreground ring-1 ring-warning/40"
                : "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground";
            return (
              <RouterAnchor
                className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${stateClassName}`}
                data-environment-pill={environment.env}
                href={environmentSwitchHref(href, scope, environment.env)}
                key={environment.environmentId}
                title={environment.name}
              >
                {environment.guarded ? <span className="size-1.5 rounded-full bg-warning" /> : null}
                {environment.env}
              </RouterAnchor>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function appSummary(appSlug: string | undefined) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="flex shrink-0">
        <span className="h-3.5 w-2 rounded-l bg-arm-control" />
        <span className="h-3.5 w-2 rounded-r bg-arm-treatment" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5 text-left">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          App
        </span>
        <span className="truncate text-base font-semibold tracking-tight">
          {appSlug ?? "Choose an App"}
        </span>
      </span>
      <span aria-hidden="true" className="text-muted-foreground group-open:rotate-180">
        ▾
      </span>
    </span>
  );
}

function sectionAt(pathname: string, scope: UrlScope): string {
  const root = scopedHref(scope);
  if (pathname === root || !pathname.startsWith(`${root}/`)) {
    return "";
  }
  const section = pathname.slice(root.length + 1).split("/", 1)[0] ?? "";
  return SECTION_KEYS.has(section) ? section : "";
}

function appHref(
  app: NavigationOrg["apps"][number],
  orgSlug: string,
  currentEnv: string | undefined,
  currentSection: string,
): string {
  const environment =
    (currentEnv ? app.environments.find((candidate) => candidate.env === currentEnv) : undefined) ??
    app.environments[0];
  if (!environment) {
    throw new Error(["App", app.appSlug, "has no Environment destination"].join(" "));
  }
  return scopedHref(
    { orgSlug, appSlug: app.appSlug, env: environment.env },
    currentEnv === environment.env ? currentSection : "",
  );
}
