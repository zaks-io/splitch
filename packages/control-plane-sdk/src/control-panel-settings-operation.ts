import type { ControlPanelOperation } from "./control-panel-identity";

const OVERVIEW_PATH = /^\/control-panel\/apps\/([^/]+)\/envs\/([^/]+)\/overview\/?$/;
const SETTINGS_PATH = /^\/control-panel\/apps\/([^/]+)\/envs\/([^/]+)\/settings\/?$/;
const ENVIRONMENT_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/?$/;
const CLIENT_KEY_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/client-key\/?$/;
const API_KEYS_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/api-keys\/?$/;
const API_KEY_REVOKE_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/api-keys\/([^/]+)\/revoke\/?$/;
const SCOPED_SETTINGS_OPERATIONS = [
  [OVERVIEW_PATH, "GET", "overview_get"],
  [SETTINGS_PATH, "GET", "settings_get"],
  [ENVIRONMENT_PATH, "PATCH", "environment_update"],
  [CLIENT_KEY_PATH, "PATCH", "client_key_update"],
  [API_KEYS_PATH, "POST", "api_keys_create"],
] as const;
const SCOPED_SETTINGS_IDS = SCOPED_SETTINGS_OPERATIONS.map(([, , id]) => id);

export function parseControlPanelSettingsOperation(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  return parseApiKeyRevoke(method, pathname) ?? parseScopedSettingsOperation(method, pathname);
}

export function isControlPanelSettingsOperation(value: Record<string, unknown>): value is Extract<
  ControlPanelOperation,
  {
    id:
      | "overview_get"
      | "settings_get"
      | "environment_update"
      | "client_key_update"
      | "api_keys_create"
      | "api_key_revoke";
  }
> {
  if (typeof value.id !== "string") return false;
  if (value.id === "api_key_revoke") {
    return (
      hasExactKeys(value, ["id", "appId", "environmentId", "keyId"]) &&
      hasAppEnvironment(value) &&
      isNonEmptyString(value.keyId)
    );
  }
  return (
    SCOPED_SETTINGS_IDS.includes(value.id as (typeof SCOPED_SETTINGS_IDS)[number]) &&
    hasExactKeys(value, ["id", "appId", "environmentId"]) &&
    hasAppEnvironment(value)
  );
}

function parseApiKeyRevoke(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "POST") return null;
  const match = pathname.match(API_KEY_REVOKE_PATH);
  const [appId, environmentId, keyId] = decodeMatches(match, 3);
  return appId && environmentId && keyId
    ? { id: "api_key_revoke", appId, environmentId, keyId }
    : null;
}

function parseScopedSettingsOperation(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  for (const [pattern, expectedMethod, id] of SCOPED_SETTINGS_OPERATIONS) {
    const match = pathname.match(pattern);
    if (method !== expectedMethod || !match) continue;
    const [appId, environmentId] = decodeMatches(match, 2);
    return appId && environmentId ? { id, appId, environmentId } : null;
  }
  return null;
}

function decodeMatches(match: RegExpMatchArray | null, count: number): Array<string | null> {
  return Array.from({ length: count }, (_, index) => decodeSegment(match?.[index + 1]));
}

function decodeSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function hasAppEnvironment(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.appId) && isNonEmptyString(value.environmentId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
