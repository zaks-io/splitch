const MAX_IDENTITY_LIFETIME_SECONDS = 30;

export const CONTROL_PANEL_IDENTITY_HEADER = "x-splitch-panel-identity";
export const CONTROL_PANEL_ENVIRONMENT_HEADER = "x-splitch-panel-environment";

export type ControlPanelOperation =
  | { id: "apps_create"; orgId: string }
  | { id: "flags_list" | "flags_create"; appId: string; environmentId: string }
  | { id: "flag_config_get"; appId: string; environmentId: string };

export interface ControlPanelDownstreamIdentity {
  version: 1;
  operation: ControlPanelOperation;
  actorId: string;
  expiresAt: number;
  nonce: string;
}

interface IdentityOptions {
  nowSeconds?: number;
  sessionExpiresAt: number;
  nonce?: string;
}

const APPS_PATH = /^\/orgs\/([^/]+)\/apps\/?$/;
const FLAGS_PATH = /^\/apps\/([^/]+)\/flags\/?$/;
const FLAG_CONFIG_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/[^/]+\/config\/?$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
): ControlPanelOperation | null {
  return (
    parseAppsCreate(method, pathname) ??
    parseFlags(method, pathname, panelEnvironmentId) ??
    parseConfig(method, pathname)
  );
}

export function issueControlPanelIdentity(
  operation: ControlPanelOperation,
  actorId: string,
  options: IdentityOptions,
): ControlPanelDownstreamIdentity {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(options.sessionExpiresAt, nowSeconds + MAX_IDENTITY_LIFETIME_SECONDS);
  const nonce = options.nonce ?? crypto.randomUUID();
  if (!actorId || expiresAt <= nowSeconds || !NONCE.test(nonce)) {
    throw new Error("control-panel downstream identity is invalid");
  }
  return { version: 1, operation, actorId, expiresAt, nonce };
}

export function serializeControlPanelIdentity(identity: ControlPanelDownstreamIdentity): string {
  return encodeURIComponent(JSON.stringify(identity));
}

export function parseControlPanelIdentity(
  value: string | null,
): ControlPanelDownstreamIdentity | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    return isControlPanelIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function verifyControlPanelIdentity(
  identity: ControlPanelDownstreamIdentity,
  expectedOperation: ControlPanelOperation,
  nowSeconds: number,
): boolean {
  return (
    identity.expiresAt > nowSeconds &&
    identity.expiresAt <= nowSeconds + MAX_IDENTITY_LIFETIME_SECONDS &&
    sameOperation(identity.operation, expectedOperation)
  );
}

function parseAppsCreate(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(APPS_PATH);
  const orgId = match?.[1] ? decodeSegment(match[1]) : null;
  return method === "POST" && orgId ? { id: "apps_create", orgId } : null;
}

function parseFlags(
  method: string,
  pathname: string,
  environmentValue?: string,
): ControlPanelOperation | null {
  const match = pathname.match(FLAGS_PATH);
  if ((method !== "GET" && method !== "POST") || !match?.[1] || !environmentValue) return null;
  const appId = decodeSegment(match[1]);
  const environmentId = decodeSegment(environmentValue);
  if (!appId || !environmentId) return null;
  return { id: method === "GET" ? "flags_list" : "flags_create", appId, environmentId };
}

function parseConfig(method: string, pathname: string): ControlPanelOperation | null {
  const match = pathname.match(FLAG_CONFIG_PATH);
  if (method !== "GET" || !match?.[1] || !match[2]) return null;
  const appId = decodeSegment(match[1]);
  const environmentId = decodeSegment(match[2]);
  return appId && environmentId ? { id: "flag_config_get", appId, environmentId } : null;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isControlPanelIdentity(value: unknown): value is ControlPanelDownstreamIdentity {
  if (
    !isRecord(value) ||
    !hasKeys(value, ["version", "operation", "actorId", "expiresAt", "nonce"])
  ) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.actorId === "string" &&
    value.actorId.length > 0 &&
    Number.isInteger(value.expiresAt) &&
    typeof value.nonce === "string" &&
    NONCE.test(value.nonce) &&
    isControlPanelOperation(value.operation)
  );
}

function isControlPanelOperation(value: unknown): value is ControlPanelOperation {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.id === "apps_create") {
    return hasKeys(value, ["id", "orgId"]) && isNonEmptyString(value.orgId);
  }
  if (value.id === "flags_list" || value.id === "flags_create" || value.id === "flag_config_get") {
    return (
      hasKeys(value, ["id", "appId", "environmentId"]) &&
      isNonEmptyString(value.appId) &&
      isNonEmptyString(value.environmentId)
    );
  }
  return false;
}

function sameOperation(left: ControlPanelOperation, right: ControlPanelOperation): boolean {
  if (left.id !== right.id) return false;
  if (left.id === "apps_create" && right.id === "apps_create") return left.orgId === right.orgId;
  if (left.id === "apps_create" || right.id === "apps_create") return false;
  return left.appId === right.appId && left.environmentId === right.environmentId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
