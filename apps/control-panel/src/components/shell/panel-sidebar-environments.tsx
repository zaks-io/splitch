import { EnvironmentWarningDot } from "#components/environments/environment-warning-dot";
import { RouterAnchor } from "#components/shell/shell-menu";
import { changedAtLabel } from "#lib/overview/overview-view";
import type { EnvironmentScope } from "#lib/shared/loader-context";
import { environmentSwitchHref, scopedHref } from "#lib/shell/app-shell-navigation";

export function PanelSidebarEnvironments({
  appSlug,
  active,
  currentHref,
  environments,
  orgSlug,
}: {
  appSlug: string;
  active?: string;
  currentHref: string;
  environments: readonly EnvironmentScope[];
  orgSlug: string;
}) {
  const permanent = environments.filter((environment) => environment.temporary === null);
  const temporary = environments.filter((environment) => environment.temporary !== null);
  const groups = [
    { label: "Environment", items: permanent },
    { label: "Temporary Environments", items: temporary },
  ];
  return (
    <div className="grid gap-2">
      {groups.map(({ label, items }) => {
        if (items.length === 0) return null;
        return (
          <nav aria-label={label} className="flex flex-wrap items-center gap-1 px-1.5" key={label}>
            <span className="mr-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
              {label}
            </span>
            {items.map((environment) => {
              const stateClassName = environmentPillClassName(environment, active);
              const href = environmentHref(currentHref, orgSlug, appSlug, active, environment.env);
              return (
                <RouterAnchor
                  aria-current={environment.env === active ? "page" : undefined}
                  className={`flex max-w-full flex-wrap min-h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${stateClassName}`}
                  data-environment-pill={environment.env}
                  href={href}
                  key={environment.environmentId}
                  title={environment.name}
                >
                  {environment.guarded ? <EnvironmentWarningDot /> : null}
                  <span className="shrink-0 whitespace-nowrap">{environment.env}</span>
                  {environment.temporary ? (
                    <span className="font-normal">
                      Expires{" "}
                      <time dateTime={environment.temporary.expiresAt}>
                        {changedAtLabel(environment.temporary.expiresAt)}
                      </time>
                    </span>
                  ) : null}
                </RouterAnchor>
              );
            })}
          </nav>
        );
      })}
    </div>
  );
}

function environmentPillClassName(environment: EnvironmentScope, active: string | undefined) {
  if (environment.env !== active)
    return "text-muted-foreground hover:bg-accent hover:text-accent-foreground";
  return environment.guarded
    ? "bg-warning-muted text-warning-foreground ring-1 ring-warning/40"
    : "bg-primary text-primary-foreground";
}

function environmentHref(
  currentHref: string,
  orgSlug: string,
  appSlug: string,
  active: string | undefined,
  nextEnv: string,
) {
  return active
    ? environmentSwitchHref(currentHref, { orgSlug, appSlug, env: active }, nextEnv)
    : scopedHref({ orgSlug, appSlug, env: nextEnv }, "flags");
}
