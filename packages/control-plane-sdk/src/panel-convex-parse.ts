import type { ControlPanelOperation } from "./control-panel-operation.js";

/**
 * Convex setup and rotation originate in the customer Component, so the Panel
 * vocabulary exposes only the operator's list and revoke actions.
 */
const INSTALLATIONS_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/integrations\/convex\/installations\/?$/;
const INSTALLATION_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/integrations\/convex\/installations\/([^/]+)\/?$/;

export function parseConvexIntegration(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  return (
    parseInstallationResource(method, pathname) ?? parseInstallationCollection(method, pathname)
  );
}

function parseInstallationCollection(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  if (method !== "GET") return null;
  const match = pathname.match(INSTALLATIONS_PATH);
  const appId = decodeMatch(match, 1);
  const environmentId = decodeMatch(match, 2);
  return appId && environmentId
    ? { id: "convex_panel_installations_list", appId, environmentId }
    : null;
}

function parseInstallationResource(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "DELETE") return null;
  const match = pathname.match(INSTALLATION_PATH);
  const appId = decodeMatch(match, 1);
  const environmentId = decodeMatch(match, 2);
  const installationId = decodeMatch(match, 3);
  return appId && environmentId && installationId
    ? { id: "convex_panel_installations_delete", appId, environmentId, installationId }
    : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  const value = match?.[index];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
