import { Tabs, TabsList, TabsTrigger } from "@splitch/ui/components/tabs";
import { Link } from "@tanstack/react-router";
import { appHomeHref, scopedHref } from "#lib/app-shell-navigation";
import { EnvironmentWarningDot } from "./environment-warning-dot";

export function EnvironmentSegmentedControl({
  active,
  appSlug,
  environments,
  orgSlug,
  section,
}: {
  orgSlug: string;
  appSlug: string;
  environments: ReadonlyArray<{ env: string; guarded: boolean }>;
  active: "all" | string;
  section: string;
}) {
  return (
    <nav aria-label="Environment" data-environment-segmented>
      <Tabs value={active}>
        <TabsList>
          <TabsTrigger
            data-environment-segment="all"
            render={<Link to={appHomeHref({ orgSlug, appSlug })} />}
            value="all"
          >
            All environments
          </TabsTrigger>
          {environments.map((environment) => (
            <TabsTrigger
              data-environment-segment={environment.env}
              key={environment.env}
              render={<Link to={scopedHref({ orgSlug, appSlug, env: environment.env }, section)} />}
              value={environment.env}
            >
              {environment.guarded ? <EnvironmentWarningDot /> : null}
              {environment.env}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </nav>
  );
}
