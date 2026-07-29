const MAX_DELEGATION_LIFETIME_SECONDS = 30;
const MIN_SECRET_BYTES = 32;

export const CONTROL_PANEL_DELEGATION_HEADER = "x-splitch-panel-delegation";
export const CONTROL_PANEL_ENVIRONMENT_HEADER = "x-splitch-panel-environment";

export type ControlPanelOperation =
  | { id: "apps_create"; orgId: string }
  | { id: "experiments_detail" }
  | { id: "experiments_list" }
  | { id: "flags_list" | "flags_create"; appId: string; environmentId: string }
  | { id: "flag_config_get"; appId: string; environmentId: string; flagId: string }
  | {
      id:
        | "metrics_list"
        | "metrics_create"
        | "settings_get"
        | "environment_update"
        | "client_key_update"
        | "api_keys_create";
      appId: string;
      environmentId: string;
    }
  | {
      id: "metrics_get" | "metrics_update" | "metrics_delete";
      appId: string;
      environmentId: string;
      metricId: string;
    }
  | {
      id: "api_key_revoke";
      appId: string;
      environmentId: string;
      keyId: string;
    };

export interface ControlPanelDelegationClaims {
  version: 1;
  operation: ControlPanelOperation;
  actorId: string;
  expiresAt: number;
  nonce: string;
  bodyDigest: string;
}

interface DelegationOptions {
  nowSeconds?: number;
  sessionExpiresAt: number;
  nonce?: string;
}

const APPS_PATH = /^\/orgs\/([^/]+)\/apps\/?$/;
const EXPERIMENT_DETAIL_PATH = "/control-panel/experiments/detail";
const EXPERIMENTS_PATH = "/control-panel/experiments/list";
const FLAGS_PATH = /^\/apps\/([^/]+)\/flags\/?$/;
const FLAG_CONFIG_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/([^/]+)\/config\/?$/;
const METRICS_PATH = /^\/apps\/([^/]+)\/metrics\/?$/;
const METRIC_PATH = /^\/apps\/([^/]+)\/metrics\/([^/]+)\/?$/;
const METRIC_COLLECTION_METHODS = {
  GET: "metrics_list",
  POST: "metrics_create",
} as const;
const METRIC_RESOURCE_METHODS = {
  GET: "metrics_get",
  PATCH: "metrics_update",
  DELETE: "metrics_delete",
} as const;
const SETTINGS_PATH = /^\/control-panel\/apps\/([^/]+)\/envs\/([^/]+)\/settings\/?$/;
const ENVIRONMENT_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/?$/;
const CLIENT_KEY_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/client-key\/?$/;
const API_KEYS_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/api-keys\/?$/;
const API_KEY_REVOKE_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/api-keys\/([^/]+)\/revoke\/?$/;
const SCOPED_OPERATION_IDS = [
  "flags_list",
  "flags_create",
  "metrics_list",
  "metrics_create",
  "settings_get",
  "environment_update",
  "client_key_update",
  "api_keys_create",
] as const;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const BODY_DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;

export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
): ControlPanelOperation | null {
  return (
    parseAppsCreate(method, pathname) ??
    parseExperimentsList(method, pathname) ??
    parseFlags(method, pathname, panelEnvironmentId) ??
    parseConfig(method, pathname) ??
    parseEnvironmentSettings(method, pathname) ??
    parseMetrics(method, pathname, panelEnvironmentId)
  );
}

function parseExperimentsList(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "POST") return null;
  if (pathname === EXPERIMENTS_PATH) return { id: "experiments_list" };
  if (pathname === EXPERIMENT_DETAIL_PATH) return { id: "experiments_detail" };
  return null;
}

export async function issueControlPanelDelegation(
  request: Request,
  operation: ControlPanelOperation,
  actorId: string,
  secret: string,
  options: DelegationOptions,
): Promise<string> {
  assertSecret(secret);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(
    options.sessionExpiresAt,
    nowSeconds + MAX_DELEGATION_LIFETIME_SECONDS,
  );
  const nonce = options.nonce ?? crypto.randomUUID();
  const bodyDigest = await canonicalRequestBodyDigest(request);
  if (!actorId || expiresAt <= nowSeconds || !NONCE.test(nonce) || !bodyDigest) {
    throw new Error("control-panel delegation is invalid");
  }
  const claims: ControlPanelDelegationClaims = {
    version: 1,
    operation,
    actorId,
    expiresAt,
    nonce,
    bodyDigest,
  };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifyControlPanelDelegation(
  value: string | null,
  request: Request,
  expectedOperation: ControlPanelOperation,
  secret: string,
  nowSeconds: number,
): Promise<ControlPanelDelegationClaims | null> {
  if (!validSecret(secret)) return null;
  const compact = parseCompactDelegation(value);
  if (!compact || !(await signatureValid(compact.payload, compact.signature, secret))) return null;
  const claims = parseClaims(compact.payload);
  if (
    !claims ||
    claims.expiresAt <= nowSeconds ||
    claims.expiresAt > nowSeconds + MAX_DELEGATION_LIFETIME_SECONDS ||
    !sameOperation(claims.operation, expectedOperation)
  ) {
    return null;
  }
  const bodyDigest = await canonicalRequestBodyDigest(request);
  return bodyDigest === claims.bodyDigest ? claims : null;
}

export async function canonicalRequestBodyDigest(request: Request): Promise<string | null> {
  const body = await request.clone().text();
  let canonicalBody = body;
  if (body.length > 0 && isJson(request.headers.get("content-type"))) {
    try {
      canonicalBody = canonicalJson(JSON.parse(body) as unknown);
    } catch {
      return null;
    }
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalBody) as unknown as BufferSource,
  );
  return `sha256:${base64UrlEncode(new Uint8Array(digest))}`;
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
  if (method !== "GET" || !match?.[1] || !match[2] || !match[3]) return null;
  const appId = decodeSegment(match[1]);
  const environmentId = decodeSegment(match[2]);
  const flagId = decodeSegment(match[3]);
  return appId && environmentId && flagId
    ? { id: "flag_config_get", appId, environmentId, flagId }
    : null;
}

function parseMetrics(
  method: string,
  pathname: string,
  environmentValue?: string,
): ControlPanelOperation | null {
  const environmentId = environmentValue ? decodeSegment(environmentValue) : null;
  if (!environmentId) return null;
  return (
    parseMetricCollection(method, pathname, environmentId) ??
    parseMetricResource(method, pathname, environmentId)
  );
}

function parseMetricCollection(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = METRIC_COLLECTION_METHODS[method as keyof typeof METRIC_COLLECTION_METHODS];
  const appId = decodeMatch(pathname.match(METRICS_PATH), 1);
  return id && appId ? { id, appId, environmentId } : null;
}

function parseMetricResource(
  method: string,
  pathname: string,
  environmentId: string,
): ControlPanelOperation | null {
  const id = METRIC_RESOURCE_METHODS[method as keyof typeof METRIC_RESOURCE_METHODS];
  const resource = pathname.match(METRIC_PATH);
  const appId = decodeMatch(resource, 1);
  const metricId = decodeMatch(resource, 2);
  return id && appId && metricId ? { id, appId, environmentId, metricId } : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  return match?.[index] ? decodeSegment(match[index]) : null;
}

function parseEnvironmentSettings(method: string, pathname: string): ControlPanelOperation | null {
  return parseApiKeyRevoke(method, pathname) ?? parseScopedSettingsOperation(method, pathname);
}

function parseApiKeyRevoke(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "POST") return null;
  const revoke = pathname.match(API_KEY_REVOKE_PATH);
  if (!revoke?.[1] || !revoke[2] || !revoke[3]) return null;
  const [appId, environmentId, keyId] = decodedSegments(revoke.slice(1, 4));
  return appId && environmentId && keyId
    ? { id: "api_key_revoke", appId, environmentId, keyId }
    : null;
}

function parseScopedSettingsOperation(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  for (const [pattern, expectedMethod, id] of [
    [SETTINGS_PATH, "GET", "settings_get"],
    [ENVIRONMENT_PATH, "PATCH", "environment_update"],
    [CLIENT_KEY_PATH, "PATCH", "client_key_update"],
    [API_KEYS_PATH, "POST", "api_keys_create"],
  ] as const) {
    const match = pathname.match(pattern);
    if (method !== expectedMethod || !match?.[1] || !match[2]) continue;
    const [appId, environmentId] = decodedSegments(match.slice(1, 3));
    return appId && environmentId ? { id, appId, environmentId } : null;
  }
  return null;
}

function decodedSegments(values: string[]): Array<string | null> {
  return values.map(decodeSegment);
}

function parseCompactDelegation(
  value: string | null,
): { payload: string; signature: string } | null {
  if (!value) return null;
  const segments = value.split(".");
  const payload = segments[0];
  const signature = segments[1];
  if (segments.length !== 2 || !payload || !signature) return null;
  return { payload, signature };
}

function parseClaims(payload: string): ControlPanelDelegationClaims | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as unknown;
    return isControlPanelDelegationClaims(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, ["sign"]),
    new TextEncoder().encode(payload) as unknown as BufferSource,
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function signatureValid(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      base64UrlDecode(signature) as unknown as BufferSource,
      new TextEncoder().encode(payload) as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("request body is not canonical JSON");
}

function isJson(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isControlPanelDelegationClaims(value: unknown): value is ControlPanelDelegationClaims {
  if (
    !isRecord(value) ||
    !hasKeys(value, ["version", "operation", "actorId", "expiresAt", "nonce", "bodyDigest"])
  ) {
    return false;
  }
  return (
    value.version === 1 &&
    isNonEmptyString(value.actorId) &&
    Number.isInteger(value.expiresAt) &&
    typeof value.nonce === "string" &&
    NONCE.test(value.nonce) &&
    typeof value.bodyDigest === "string" &&
    BODY_DIGEST.test(value.bodyDigest) &&
    isControlPanelOperation(value.operation)
  );
}

function isControlPanelOperation(value: unknown): value is ControlPanelOperation {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.id === "apps_create") return isAppCreateOperation(value);
  if (isExperimentsOperation(value.id)) return hasKeys(value, ["id"]);
  if (value.id === "flag_config_get") return isFlagConfigOperation(value);
  if (isScopedOperationId(value.id)) return isAppCollectionOperation(value);
  if (isMetricResourceOperationId(value.id)) return isMetricResourceOperation(value);
  if (value.id === "api_key_revoke") {
    return isApiKeyRevokeOperation(value);
  }
  return false;
}

function isExperimentsOperation(value: string): boolean {
  return value === "experiments_list" || value === "experiments_detail";
}

function isAppCreateOperation(value: Record<string, unknown>): boolean {
  return hasKeys(value, ["id", "orgId"]) && isNonEmptyString(value.orgId);
}

function isFlagConfigOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "flagId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.flagId)
  );
}

function isAppCollectionOperation(value: Record<string, unknown>): boolean {
  return hasKeys(value, ["id", "appId", "environmentId"]) && hasAppEnvironment(value);
}

function isMetricResourceOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "metricId"]) &&
    hasAppEnvironment(value) &&
    isNonEmptyString(value.metricId)
  );
}

function hasAppEnvironment(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.appId) && isNonEmptyString(value.environmentId);
}

function isMetricResourceOperationId(
  id: string,
): id is "metrics_get" | "metrics_update" | "metrics_delete" {
  return id === "metrics_get" || id === "metrics_update" || id === "metrics_delete";
}

function isApiKeyRevokeOperation(value: Record<string, unknown>): boolean {
  return (
    hasKeys(value, ["id", "appId", "environmentId", "keyId"]) &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.environmentId) &&
    isNonEmptyString(value.keyId)
  );
}

function isScopedOperationId(value: string): value is (typeof SCOPED_OPERATION_IDS)[number] {
  return (SCOPED_OPERATION_IDS as readonly string[]).includes(value);
}

function sameOperation(left: ControlPanelOperation, right: ControlPanelOperation): boolean {
  if (left.id !== right.id) return false;
  switch (left.id) {
    case "apps_create":
      return right.id === "apps_create" && left.orgId === right.orgId;
    case "experiments_list":
    case "experiments_detail":
      return true;
    case "flag_config_get":
      return (
        right.id === "flag_config_get" &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId &&
        left.flagId === right.flagId
      );
    case "metrics_get":
    case "metrics_update":
    case "metrics_delete":
      return (
        "metricId" in right &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId &&
        left.metricId === right.metricId
      );
    case "api_key_revoke":
      return (
        "keyId" in right &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId &&
        left.keyId === right.keyId
      );
    default:
      return (
        "appId" in right &&
        "environmentId" in right &&
        left.appId === right.appId &&
        left.environmentId === right.environmentId
      );
  }
}

function assertSecret(secret: string): void {
  if (!validSecret(secret)) throw new Error("control-panel delegation secret is invalid");
}

function validSecret(secret: string): boolean {
  return new TextEncoder().encode(secret).byteLength >= MIN_SECRET_BYTES;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
