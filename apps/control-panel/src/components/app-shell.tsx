import { Badge } from "@splitch/ui/components/badge";
import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShellSwitchers } from "#components/app-shell-switcher";
import { LiveUpdatesClient } from "#components/live-updates-client";
import type { ScopedLoaderContext } from "#lib/loader-context";

type AppShellProps = {
  context: ScopedLoaderContext;
  queryClient: QueryClient;
};

const sections = [
  { label: "Overview", to: "/$orgSlug/$appSlug/$env" },
  { label: "Flags", to: "/$orgSlug/$appSlug/$env/flags" },
  { label: "Experiments", to: "/$orgSlug/$appSlug/$env/experiments" },
  { label: "Segments", to: "/$orgSlug/$appSlug/$env/segments", scope: "App-level" },
  { label: "Metrics", to: "/$orgSlug/$appSlug/$env/metrics", scope: "App-level" },
  { label: "Settings", to: "/$orgSlug/$appSlug/$env/settings" },
] as const;

export function AppShell({ context, queryClient }: AppShellProps) {
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      data-app-id={context.scope.appId}
      data-app-shell="ready"
      data-environment-id={context.scope.environmentId}
      data-hydrated={isHydrated ? "true" : "false"}
      key={`${context.scope.appId}:${context.scope.environmentId}`}
    >
      <LiveUpdatesClient queryClient={queryClient} scope={context.scope} />
      <header className="flex flex-col gap-4 border-border border-b bg-muted/30 px-4 py-4 lg:flex-row lg:items-end lg:px-6">
        <div className="grid shrink-0 gap-1 lg:w-52">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-primary" />
            <span className="font-semibold text-foreground">{context.scope.appSlug}</span>
          </div>
          <p className="truncate text-muted-foreground text-xs">
            {context.scope.orgSlug} / {context.scope.env}
          </p>
        </div>
        <AppShellSwitchers context={context} />
      </header>

      <div className="grid min-h-[34rem] md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="border-border border-b bg-muted/20 p-3 md:border-r md:border-b-0">
          <nav
            aria-label="App sections"
            className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-1"
          >
            {sections.map((section) => (
              <Link
                activeOptions={{ exact: section.to === "/$orgSlug/$appSlug/$env" }}
                activeProps={{
                  className:
                    "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground",
                }}
                className="flex min-h-10 items-center justify-between gap-2 rounded-md px-3 py-2 font-medium text-muted-foreground text-sm hover:bg-accent hover:text-accent-foreground"
                key={section.label}
                params={{
                  appSlug: context.scope.appSlug,
                  env: context.scope.env,
                  orgSlug: context.scope.orgSlug,
                }}
                to={section.to}
              >
                <span>{section.label}</span>
                {"scope" in section ? (
                  <Badge className="shrink-0 px-1.5 text-[9px] sm:text-[10px]" variant="outline">
                    {section.scope}
                  </Badge>
                ) : null}
              </Link>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 bg-background p-5 sm:p-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
