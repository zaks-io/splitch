import { CONTROL_PANEL_DELEGATION_HEADER } from "@splitch/contracts";
import {
  isControlPanelOperation,
  parseControlPanelOperation as parseOperation,
  sameControlPanelOperation,
} from "./control-panel-operation";

const MAX_DELEGATION_LIFETIME_SECONDS = 30;
const MIN_SECRET_BYTES = 32;

export { CONTROL_PANEL_DELEGATION_HEADER };
export const CONTROL_PANEL_ENVIRONMENT_HEADER = "x-splitch-panel-environment";

export type ControlPanelOperation =
  | { id: "apps_create"; orgId: string }
  | { id: "app_attention_rollup_get"; appId: string }
  | { id: "experiments_detail" }
  | { id: "experiments_list" }
  | { id: "experiments_results" }
  | {
      id: "experiments_update" | "experiments_start";
      appId: string;
      environmentId: string;
      experimentId: string;
    }
  | { id: "flags_list" | "flags_create"; appId: string; environmentId: string }
  | { id: "flag_config_get"; appId: string; environmentId: string; flagId: string }
  | {
      id:
        | "metrics_list"
        | "metrics_create"
        | "overview_get"
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

export function parseControlPanelOperation(
  method: string,
  pathname: string,
  panelEnvironmentId?: string,
): ControlPanelOperation | null {
  return parseOperation(method, pathname, panelEnvironmentId);
}

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

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const BODY_DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
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
    !sameControlPanelOperation(claims.operation, expectedOperation)
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
