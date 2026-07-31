import { useRouterState } from "@tanstack/react-router";
import { ShellMenu, ShellMenuGroup, ShellMenuLink } from "#components/shell-menu";
import { environmentSwitchHref, scopedHref } from "#lib/app-shell-navigation";
import type { ScopedLoaderContext } from "#lib/loader-context";

type SwitcherProps = {
  context: ScopedLoaderContext;
};

export function AppShellSwitchers({ context }: SwitcherProps) {
  const href = useRouterState({ select: (state) => state.location.href });
  const currentOrg = context.navigation.orgs.find(
    (candidate) => candidate.orgId === context.scope.orgId,
  );
  const currentApp = currentOrg?.apps.find((candidate) => candidate.appId === context.scope.appId);

  return (
    <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
      {context.navigation.orgs.length > 1 ? (
        <ShellMenu label="Organization" value={context.scope.orgSlug}>
          {context.navigation.orgs.map((org) => (
            <ShellMenuLink href={`/${encodeURIComponent(org.orgSlug)}`} key={org.orgId}>
              {org.orgSlug}
            </ShellMenuLink>
          ))}
        </ShellMenu>
      ) : null}

      <ShellMenu label="App" value={context.scope.appSlug}>
        {currentOrg?.apps.map((app) => (
          <ShellMenuGroup key={app.appId} label={app.appSlug}>
            {app.environments.map((environment) => (
              <ShellMenuLink
                href={scopedHref({
                  appSlug: app.appSlug,
                  env: environment.env,
                  orgSlug: context.scope.orgSlug,
                })}
                key={environment.environmentId}
              >
                {environment.name} · {environment.env}
              </ShellMenuLink>
            ))}
          </ShellMenuGroup>
        ))}
      </ShellMenu>

      <ShellMenu label="Environment" value={context.scope.env}>
        {currentApp?.environments.map((environment) => (
          <ShellMenuLink
            href={environmentSwitchHref(href, context.scope, environment.env)}
            key={environment.environmentId}
          >
            {environment.name} · {environment.env}
          </ShellMenuLink>
        ))}
      </ShellMenu>
    </div>
  );
}
