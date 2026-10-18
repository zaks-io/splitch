import { Tabs, TabsList, TabsTrigger } from "@splitch/ui/components/tabs";
import { Link } from "@tanstack/react-router";
import { EnvironmentWarningDot } from "#components/environments/environment-warning-dot";
import { changedAtLabel } from "#lib/overview/overview-view";
import type { EnvironmentScope } from "#lib/shared/loader-context";
import { appHomeHref, scopedHref } from "#lib/shell/app-shell-navigation";

export function EnvironmentSegmentedControl({
  active,
  appSlug,
  environments,
  orgSlug,
  section,
}: {
  orgSlug: string;
  appSlug: string;
  environments: ReadonlyArray<Pick<EnvironmentScope, "env" | "guarded" | "temporary">>;
  active: "all" | string;
  section: string;
}) {
  const groups = [
    {
      label: "Environments",
      items: environments.filter((environment) => environment.temporary === null),
    },
    {
      label: "Temporary Environments",
      items: environments.filter((environment) => environment.temporary !== null),
    },
  ];
  return (
    <nav aria-label="Environment" className="min-w-0" data-environment-segmented>
      <Tabs value={active}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger
            nativeButton={false}
            data-environment-segment="all"
            render={<Link to={appHomeHref({ orgSlug, appSlug })} />}
            value="all"
          >
            All environments
          </TabsTrigger>
          {groups.map(({ label, items }) =>
            items.length > 0 ? (
              <fieldset aria-label={label} className="flex items-center gap-1" key={label}>
                {label === "Temporary Environments" ? (
                  <span className="px-2 text-xs text-muted-foreground">{label}</span>
                ) : null}
                {items.map((environment) => (
                  <TabsTrigger
                    nativeButton={false}
                    data-environment-segment={environment.env}
                    key={environment.env}
                    render={
                      <Link to={scopedHref({ orgSlug, appSlug, env: environment.env }, section)} />
                    }
                    value={environment.env}
                  >
                    {environment.guarded ? <EnvironmentWarningDot /> : null}
                    {environment.env}
                    {environment.temporary ? (
                      <span className="font-normal">
                        Expires{" "}
                        <time dateTime={environment.temporary.expiresAt}>
                          {changedAtLabel(environment.temporary.expiresAt)}
                        </time>
                      </span>
                    ) : null}
                  </TabsTrigger>
                ))}
              </fieldset>
            ) : null,
          )}
        </TabsList>
      </Tabs>
    </nav>
  );
}
