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
