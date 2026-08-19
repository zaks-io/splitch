import type { ControlPanelOperation } from "./control-panel-operation.js";

/**
 * The App-scoped half of the Panel vocabulary (App Settings, SPL-114).
 *
 * These operations name an App and NOTHING else. That is deliberate: renaming
 * an App, changing who may reach it, and deleting it are all App-level acts, so
 * a claim that also named an Environment would assert a scope the resource does
 * not have. The Environment-scoped settings operations stay in
 * `control-panel-operation.ts` and remain a disjoint path family.
 */

const APP_SETTINGS_PATH = /^\/control-panel\/apps\/([^/]+)\/settings\/?$/;
const APP_PATH = /^\/apps\/([^/]+)\/?$/;
const APP_MEMBERS_PATH = /^\/apps\/([^/]+)\/members\/?$/;
const APP_MEMBER_PATH = /^\/apps\/([^/]+)\/members\/([^/]+)\/?$/;

const APP_RESOURCE_METHODS = {
  PATCH: "apps_update",
  DELETE: "apps_delete",
} as const;

const APP_MEMBER_COLLECTION_METHODS = {
  GET: "app_members_list",
  POST: "app_members_add",
} as const;

const APP_MEMBER_RESOURCE_METHODS = {
  PATCH: "app_members_update",
  DELETE: "app_members_remove",
} as const;

export function parseAppScoped(method: string, pathname: string): ControlPanelOperation | null {
  return (
    parseAppSettings(method, pathname) ??
    parseAppResource(method, pathname) ??
    parseAppMemberCollection(method, pathname) ??
    parseAppMemberResource(method, pathname)
  );
}

function parseAppSettings(method: string, pathname: string): ControlPanelOperation | null {
  const appId = decodeMatch(pathname.match(APP_SETTINGS_PATH), 1);
  return method === "GET" && appId ? { id: "app_settings_get", appId } : null;
}

function parseAppResource(method: string, pathname: string): ControlPanelOperation | null {
  const id = APP_RESOURCE_METHODS[method as keyof typeof APP_RESOURCE_METHODS];
  const appId = decodeMatch(pathname.match(APP_PATH), 1);
  return id && appId ? { id, appId } : null;
}

function parseAppMemberCollection(method: string, pathname: string): ControlPanelOperation | null {
  const id = APP_MEMBER_COLLECTION_METHODS[method as keyof typeof APP_MEMBER_COLLECTION_METHODS];
  const appId = decodeMatch(pathname.match(APP_MEMBERS_PATH), 1);
  return id && appId ? { id, appId } : null;
}

function parseAppMemberResource(method: string, pathname: string): ControlPanelOperation | null {
  const id = APP_MEMBER_RESOURCE_METHODS[method as keyof typeof APP_MEMBER_RESOURCE_METHODS];
  const match = pathname.match(APP_MEMBER_PATH);
  const appId = decodeMatch(match, 1);
  const userId = decodeMatch(match, 2);
  return id && appId && userId ? { id, appId, userId } : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  const value = match?.[index];
  return value ? decodeSegment(value) : null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
