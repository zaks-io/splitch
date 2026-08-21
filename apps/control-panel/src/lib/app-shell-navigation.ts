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
  { label: "Flags", to: "/$orgSlug/$appSlug/$env/flags", status: "shipped" },
  { label: "Experiments", to: "/$orgSlug/$appSlug/$env/experiments", status: "shipped" },
  { label: "Overview", to: "/$orgSlug/$appSlug/$env", status: "shipped" },
  {
    label: "Segments",
    to: "/$orgSlug/$appSlug/$env/segments",
    scope: "App-level",
    status: "shipped",
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

const APP_SCOPE_PREFIX = "/$orgSlug/$appSlug/$env";

/**
 * Every registry entry today is App-scoped. A destination outside that scope
 * would build a href that can never equal a real pathname, so the guard in
 * `deferredDestinationAt` would silently never fire for it and it would be
 * treated as shipped — the disguised-default shape ADR-0036 bans. Fail loud
 * instead of shipping that gap quietly.
 */
export function destinationSection(to: string): string {
  if (!to.startsWith(APP_SCOPE_PREFIX)) {
    throw new Error(
      `appSectionRegistry entry "${to}" is outside the App scope (${APP_SCOPE_PREFIX}); ` +
        "deferredDestinationAt only matches App-scoped hrefs.",
    );
  }
  return to.slice(APP_SCOPE_PREFIX.length).replace(/^\/+/, "");
}

/**
 * Registering a destination `deferred` hides it from the sidebar, but the
 * route still exists and a bookmark or shared link can still reach it. This
 * matches a direct request's pathname against every `deferred` entry in the
 * registry (not just Segments), so the App-scope loader can answer the whole
 * class uniformly instead of each deferred route file special-casing itself.
 *
 * Matches the destination's own path AND everything under it (prefix match,
 * not `===`): a deferred destination with child routes (e.g. an experiment
 * detail page under a deferred `Experiments`) must not let a deep link past
 * the guard just because it targets a descendant rather than the exact href.
 */
export function deferredDestinationAt(
  pathname: string,
  scope: UrlScope,
  destinations: readonly NavigationDestination[] = appSectionRegistry,
): NavigationDestination | undefined {
  return destinations.find((destination) => {
    if (destination.status !== "deferred") {
      return false;
    }
    const href = scopedHref(scope, destinationSection(destination.to));
    return pathname === href || pathname.startsWith(`${href}/`);
  });
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
