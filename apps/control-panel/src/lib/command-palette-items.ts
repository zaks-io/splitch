import {
  appHomeHref,
  destinationSection,
  scopedHref,
  visibleAppSections,
} from "./app-shell-navigation";
import { createDelegationEnvironment } from "./flags-matrix-data";
import type { ScopeNavigation } from "./loader-context";
import type { PaletteIndex } from "./palette-index";

export interface PaletteItem {
  id: string;
  group: "Jump to" | "Actions";
  label: string;
  keywords: string[];
  href?: string;
}

type PaletteApp = ScopeNavigation["orgs"][number]["apps"][number];

export type ResolvedPaletteScope = {
  org: { orgId: string; orgSlug: string; apps: PaletteApp[] };
  app: PaletteApp | null;
  target: {
    appId: string;
    appSlug: string;
    environmentId: string;
    env: string;
  } | null;
};

export function paletteScope(
  navigation: ScopeNavigation,
  org: { orgId: string; orgSlug: string },
  app?: { appId: string; appSlug: string; env?: string },
): ResolvedPaletteScope {
  const currentOrg = navigation.orgs.find((candidate) => candidate.orgId === org.orgId);
  if (!currentOrg) {
    throw new Error("Command palette Organization is missing from navigation");
  }
  if (!app) return { org: currentOrg, app: null, target: null };

  const currentApp = currentOrg.apps.find((candidate) => candidate.appId === app.appId);
  if (!currentApp) {
    throw new Error("Command palette App is missing from navigation");
  }

  const environment = app.env
    ? currentApp.environments.find((candidate) => candidate.env === app.env)
    : currentApp.environments.length > 0
      ? createDelegationEnvironment(currentApp.environments)
      : null;
  if (app.env && !environment) {
    throw new Error("Command palette Environment is missing from navigation");
  }

  return {
    org: currentOrg,
    app: currentApp,
    target: environment
      ? {
          appId: currentApp.appId,
          appSlug: currentApp.appSlug,
          environmentId: environment.environmentId,
          env: environment.env,
        }
      : null,
  };
}

export function paletteJumpItems(
  scope: ResolvedPaletteScope,
  index: PaletteIndex | null,
): PaletteItem[] {
  const items: PaletteItem[] = scope.org.apps.map((app) => ({
    id: `app:${app.appSlug}`,
    group: "Jump to",
    label: app.appSlug,
    keywords: ["App", app.appSlug],
    href: appHomeHref({ orgSlug: scope.org.orgSlug, appSlug: app.appSlug }),
  }));

  if (!scope.app) return items;
  for (const environment of scope.app.environments) {
    items.push({
      id: `env:${scope.app.appSlug}/${environment.env}`,
      group: "Jump to",
      label: `${scope.app.appSlug} / ${environment.env}`,
      keywords: [scope.app.appSlug, environment.env, environment.name, "Environment"],
      href: scopedHref(
        { orgSlug: scope.org.orgSlug, appSlug: scope.app.appSlug, env: environment.env },
        "",
      ),
    });
  }

  if (!scope.target || !index) return items;
  for (const flag of index.flags) {
    items.push({
      id: `flag:${flag.key}`,
      group: "Jump to",
      label: flag.key,
      keywords: ["Flag", scope.target.appSlug, scope.target.env],
      href: scopedHref(scopeHref(scope), `flags/${encodeURIComponent(flag.key)}`),
    });
  }
  for (const experiment of index.experiments) {
    items.push({
      id: `experiment:${experiment.id}`,
      group: "Jump to",
      label: experiment.name,
      keywords: ["Experiment", experiment.id, scope.target.appSlug, scope.target.env],
      href: scopedHref(scopeHref(scope), `experiments/${encodeURIComponent(experiment.id)}`),
    });
  }
  return items;
}

export function paletteActionItems(scope: ResolvedPaletteScope): PaletteItem[] {
  const items: PaletteItem[] = [];
  if (scope.target) {
    items.push({
      id: "action:new-flag",
      group: "Actions",
      label: "New Flag",
      keywords: ["create", "Flag", scope.target.appSlug, scope.target.env],
    });
    for (const section of visibleAppSections) {
      items.push({
        id: `section:${section.label.toLowerCase()}`,
        group: "Actions",
        label: `Go to ${section.label}`,
        keywords: [section.label, scope.target.appSlug, scope.target.env],
        href: scopedHref(scopeHref(scope), destinationSection(section.to)),
      });
    }
  }
  items.push(
    {
      id: "org:members",
      group: "Actions",
      label: "Members",
      keywords: ["Organization", "members"],
      href: `/${encodeURIComponent(scope.org.orgSlug)}/members`,
    },
    {
      id: "org:billing",
      group: "Actions",
      label: "Billing & Usage",
      keywords: ["Organization", "billing", "usage"],
      href: `/${encodeURIComponent(scope.org.orgSlug)}/billing`,
    },
  );
  return items;
}

function scopeHref(scope: ResolvedPaletteScope) {
  if (!scope.target) throw new Error("Command palette target Environment is missing");
  return {
    orgSlug: scope.org.orgSlug,
    appSlug: scope.target.appSlug,
    env: scope.target.env,
  };
}
