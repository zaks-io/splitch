import type { RouteOwner } from "./route-contract";
import { getRoute } from "./route-registry";

export const MCP_DELEGATION_HEADER = "x-splitch-mcp-delegation";
const VERSION = 1;
const MAX_TTL_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5;
const MIN_SECRET_LENGTH = 32;

export interface McpDelegationActor {
  subject: string;
  scopes: readonly string[];
}

export interface McpDelegationReplayGuard {
  claim(jti: string, expiresAt: number, nowSeconds: number): Promise<boolean>;
}

interface McpDelegationCredential {
  version: typeof VERSION;
  issuer: "splitch-mcp-server";
  audience: RouteOwner;
  operationId: string;
  subject: string;
  scopes: string[];
  method: string;
  target: string;
  bodySha256: string;
  issuedAt: number;
  expiresAt: number;
  jti: string;
}

export async function createMcpDelegationHeader(options: {
  operationId: string;
  actor: McpDelegationActor;
  request: Request;
  secret: string;
  nowSeconds?: number;
  jti?: string;
}): Promise<string> {
  assertStrongSecret(options.secret);
  const route = getRoute(options.operationId);
  if (!route)
    throw new Error(`contracts: unknown MCP delegation operation "${options.operationId}"`);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const credential: McpDelegationCredential = {
    version: VERSION,
    issuer: "splitch-mcp-server",
    audience: route.owner,
    operationId: options.operationId,
    subject: options.actor.subject,
    scopes: [...options.actor.scopes],
    method: options.request.method,
    target: requestTarget(options.request),
    bodySha256: await requestBodySha256(options.request),
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + MAX_TTL_SECONDS,
    jti: options.jti ?? crypto.randomUUID(),
  };
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(credential)));
  return `${payload}.${await sign(payload, options.secret)}`;
}

export async function parseMcpDelegation(options: {
  request: Request;
  owner: RouteOwner;
  secret: string;
  replayGuard: McpDelegationReplayGuard;
  nowSeconds?: number;
}): Promise<McpDelegationActor | null> {
  assertStrongSecret(options.secret);
  const encoded = options.request.headers.get(MCP_DELEGATION_HEADER);
  if (!encoded) return null;
  const [payload, signature, extra] = encoded.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    !(await signatureValid(payload, signature, options.secret))
  ) {
    return null;
  }
  const credential = decodeCredential(payload);
  if (!credential) return null;

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const route = getRoute(credential.operationId);
  if (
    !route ||
    route.owner !== options.owner ||
    credential.audience !== options.owner ||
    route.method !== credential.method ||
    !routePathMatches(route.path, new URL(options.request.url).pathname) ||
    credential.method !== options.request.method ||
    credential.target !== requestTarget(options.request) ||
    credential.bodySha256 !== (await requestBodySha256(options.request)) ||
    credential.issuedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
    credential.expiresAt <= nowSeconds ||
    credential.expiresAt > credential.issuedAt + MAX_TTL_SECONDS ||
    credential.issuedAt < nowSeconds - MAX_TTL_SECONDS
  ) {
    return null;
  }
  if (!(await options.replayGuard.claim(credential.jti, credential.expiresAt, nowSeconds))) {
    return null;
  }
  return { subject: credential.subject, scopes: credential.scopes };
}

function routePathMatches(routePath: string, requestPath: string): boolean {
  const pattern = routePath
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment)))
    .join("/");
  return new RegExp(`^${pattern}$`).test(requestPath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requestTarget(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

async function requestBodySha256(request: Request): Promise<string> {
  const body = await request.clone().arrayBuffer();
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

function decodeCredential(encoded: string): McpDelegationCredential | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as Record<
      string,
      unknown
    >;
    if (
      value.version !== VERSION ||
      value.issuer !== "splitch-mcp-server" ||
      typeof value.audience !== "string" ||
      typeof value.operationId !== "string" ||
      typeof value.subject !== "string" ||
      value.subject.length === 0 ||
      value.subject.length > 256 ||
      !Array.isArray(value.scopes) ||
      value.scopes.length > 64 ||
      !value.scopes.every(
        (scope) => typeof scope === "string" && scope.length > 0 && scope.length <= 512,
      ) ||
      typeof value.method !== "string" ||
      typeof value.target !== "string" ||
      typeof value.bodySha256 !== "string" ||
      typeof value.issuedAt !== "number" ||
      !Number.isInteger(value.issuedAt) ||
      typeof value.expiresAt !== "number" ||
      !Number.isInteger(value.expiresAt) ||
      typeof value.jti !== "string" ||
      value.jti.length < 16 ||
      value.jti.length > 128
    ) {
      return null;
    }
    return value as unknown as McpDelegationCredential;
  } catch {
    return null;
  }
}

function assertStrongSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `contracts: MCP delegation secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function signatureValid(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const key = await hmacKey(secret, ["verify"]);
    return crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature) as unknown as BufferSource,
      new TextEncoder().encode(payload) as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
