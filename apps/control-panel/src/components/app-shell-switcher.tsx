import { environmentSwitchHref, scopedHref } from "#lib/app-shell-navigation";
import type { ScopedLoaderContext } from "#lib/loader-context";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";

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
      <Switcher label="Organization" value={context.scope.orgSlug}>
        {context.navigation.orgs.map((org) => (
          <MenuGroup key={org.orgId} label={org.orgSlug}>
            {org.apps.flatMap((app) =>
              app.environments.map((environment) => (
                <SwitcherLink
                  href={scopedHref({
                    appSlug: app.appSlug,
                    env: environment.env,
                    orgSlug: org.orgSlug,
                  })}
                  key={`${app.appId}:${environment.environmentId}`}
                >
                  {app.appSlug} · {environment.env}
                </SwitcherLink>
              )),
            )}
          </MenuGroup>
        ))}
      </Switcher>

      <Switcher label="App" value={context.scope.appSlug}>
        {currentOrg?.apps.map((app) => (
          <MenuGroup key={app.appId} label={app.appSlug}>
            {app.environments.map((environment) => (
              <SwitcherLink
                href={scopedHref({
                  appSlug: app.appSlug,
                  env: environment.env,
                  orgSlug: context.scope.orgSlug,
                })}
                key={environment.environmentId}
              >
                {environment.name} · {environment.env}
              </SwitcherLink>
            ))}
          </MenuGroup>
        ))}
      </Switcher>

      <Switcher label="Environment" value={context.scope.env}>
        {currentApp?.environments.map((environment) => (
          <SwitcherLink
            href={environmentSwitchHref(href, context.scope, environment.env)}
            key={environment.environmentId}
          >
            {environment.name} · {environment.env}
          </SwitcherLink>
        ))}
      </Switcher>
    </div>
  );
}

function Switcher({
  children,
  label,
  value,
}: {
  children: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <details className="group relative min-w-0">
      <summary className="grid cursor-pointer list-none gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 shadow-xs outline-none marker:hidden focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          {label}
        </span>
        <span className="flex min-w-0 items-center justify-between gap-2 text-sm text-foreground">
          <span className="truncate">{value}</span>
          <span aria-hidden="true" className="text-muted-foreground group-open:rotate-180">
            ▾
          </span>
        </span>
      </summary>
      <div className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 min-w-52 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
        {children}
      </div>
    </details>
  );
}

function MenuGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="grid gap-0.5 py-1 first:pt-0 last:pb-0">
      <p className="px-2 py-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        {label}
      </p>
      {children}
    </section>
  );
}

function SwitcherLink({ children, href }: { children: ReactNode; href: string }) {
  const router = useRouter();
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    event.currentTarget.closest("details")?.removeAttribute("open");
    router.history.push(href);
  };

  return (
    <a
      className="rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
      href={href}
      onClick={navigate}
    >
      {children}
    </a>
  );
}
