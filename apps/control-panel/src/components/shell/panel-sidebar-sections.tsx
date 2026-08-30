import { Badge } from "@splitch/ui/components/badge";
import { Link } from "@tanstack/react-router";
import type { ActiveSidebarApp } from "#components/shell/panel-sidebar-app-block";
import {
  panelSidebarActiveLinkClassName,
  panelSidebarLinkClassName,
} from "#components/shell/panel-sidebar-link-styles";
import { visibleAppSections } from "#lib/shell/app-shell-navigation";

export function PanelSidebarSections({
  app,
  orgSlug,
}: {
  app: ActiveSidebarApp & { env: string };
  orgSlug: string;
}) {
  return (
    <nav
      aria-label="App sections"
      className="flex flex-wrap gap-1 px-3 pt-4 md:grid md:grid-cols-1"
    >
      {visibleAppSections.map((section) => (
        <Link
          activeOptions={{ exact: section.to === "/$orgSlug/$appSlug/$env" }}
          activeProps={{ className: panelSidebarActiveLinkClassName }}
          className={panelSidebarLinkClassName}
          key={section.label}
          params={{ appSlug: app.appSlug, env: app.env, orgSlug }}
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
  );
}
