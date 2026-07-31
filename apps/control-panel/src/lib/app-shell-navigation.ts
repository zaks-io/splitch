/**
 * A destination is `shipped` only when its route renders real product UI or an
 * honest teaching empty state. `deferred` destinations stay registered so the
 * reason they are hidden is reviewable, but they are never rendered. Hiding a
 * destination is a UI decision only: the route keeps existing and the Worker
 * stays authoritative for membership, scope, and refusal on a direct deep link.
 */
type NavigationStatus = "shipped" | "deferred";

export type NavigationDestination = {
  readonly label: string;
  readonly to: string;
  readonly status: NavigationStatus;
  readonly scope?: string;
  readonly hiddenBecause?: string;
};

export const appSectionRegistry = [
  { label: "Overview", to: "/$orgSlug/$appSlug/$env", status: "shipped" },
  { label: "Flags", to: "/$orgSlug/$appSlug/$env/flags", status: "shipped" },
  { label: "Experiments", to: "/$orgSlug/$appSlug/$env/experiments", status: "shipped" },
  {
    label: "Segments",
    to: "/$orgSlug/$appSlug/$env/segments",
    scope: "App-level",
    status: "deferred",
    hiddenBecause: "SPL-112 has not delivered the Segments screen; the route is status copy only.",
  },
  {
    label: "Metrics",
    to: "/$orgSlug/$appSlug/$env/metrics",
    scope: "App-level",
    status: "shipped",
  },
  { label: "Settings", to: "/$orgSlug/$appSlug/$env/settings", status: "shipped" },
] as const satisfies readonly NavigationDestination[];

function isShipped<T extends NavigationDestination>(
  destination: T,
): destination is T & { readonly status: "shipped" } {
  return destination.status === "shipped";
}

export const visibleAppSections = Object.freeze(appSectionRegistry.filter(isShipped));

export type UrlScope = {
  orgSlug: string;
  appSlug: string;
  env: string;
};

export function scopedHref(scope: UrlScope, section = ""): string {
  const root = `/${encodeURIComponent(scope.orgSlug)}/${encodeURIComponent(scope.appSlug)}/${encodeURIComponent(scope.env)}`;
  return section ? `${root}/${section.replace(/^\/+/, "")}` : root;
}

export function environmentSwitchHref(
  currentHref: string,
  scope: UrlScope,
  nextEnv: string,
): string {
  const url = new URL(currentHref, "https://panel.splitch.dev");
  const currentRoot = scopedHref(scope);
  const nextRoot = scopedHref({ ...scope, env: nextEnv });

  if (url.pathname !== currentRoot && !url.pathname.startsWith(`${currentRoot}/`)) {
    return nextRoot;
  }

  return `${nextRoot}${url.pathname.slice(currentRoot.length)}${url.search}${url.hash}`;
}
