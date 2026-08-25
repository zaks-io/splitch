import {
  type AuthDoor,
  AuthDoorSchema,
  type PublicSurface,
  publicSurfaceFor,
} from "./route-contract";
import { getRoute } from "./route-registry";

export const MCP_DELEGATION_HEADER = "x-splitch-mcp-delegation";
const VERSION = 1;
type McpDelegationReplayVersion = 1 | 2;
const MAX_TTL_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5;
const MIN_SECRET_LENGTH = 32;

export interface McpDelegationActor {
  subject: string;
  scopes: readonly string[];
  /**
   * Which door minted the MCP access token this delegation stands in for. It is
   * signed with the rest of the credential so the downstream Worker learns that
   * a caller is provisional; without it, an anonymous MCP session would reach
   * door-gated routes indistinguishable from an identified one.
   */
  authDoor: AuthDoor;
}

export interface McpDelegationReplayGuard {
  claim(
    jti: string,
    expiresAt: number,
    nowSeconds: number,
    replayVersion?: McpDelegationReplayVersion,
  ): Promise<boolean>;
}

export type McpDelegationFreshnessFailure =
  | "issued_at_too_new"
  | "issued_at_too_old"
  | "expired"
  | "ttl_too_long";

interface McpDelegationCredential {
  version: typeof VERSION;
  /** Marker-less credentials predate the bounded replay shards. */
  replayVersion?: 2;
  issuer: "splitch-mcp-server";
  /**
   * The PUBLIC SURFACE the credential is addressed to, never the Worker that
   * executes the operation (ADR-0046). MCP holds no owner registry: it hands the
   * call to the surface the operation's credential kind is addressed at, and that
   * surface runs the membership, Environment-scope, and Policy gates before it
   * delegates onward over its own binding.
   */
  audience: PublicSurface;
  operationId: string;
  subject: string;
  scopes: string[];
  authDoor: AuthDoor;
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
    replayVersion: 2,
    issuer: "splitch-mcp-server",
    audience: requirePublicSurface(options.operationId, route),
    operationId: options.operationId,
    subject: options.actor.subject,
    scopes: [...options.actor.scopes],
    authDoor: options.actor.authDoor,
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
  surface: PublicSurface;
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
    publicSurfaceFor(route) !== options.surface ||
    credential.audience !== options.surface ||
    route.method !== credential.method ||
    !routePathMatches(route.path, new URL(options.request.url).pathname) ||
    credential.method !== options.request.method ||
    credential.target !== requestTarget(options.request) ||
    credential.bodySha256 !== (await requestBodySha256(options.request)) ||
    mcpDelegationFreshnessFailure(credential.issuedAt, credential.expiresAt, nowSeconds) !== null
  ) {
    return null;
  }
  if (
    !(await options.replayGuard.claim(
      credential.jti,
      credential.expiresAt,
      nowSeconds,
      credential.replayVersion ?? 1,
    ))
  ) {
    return null;
  }
  return {
    subject: credential.subject,
    scopes: credential.scopes,
    authDoor: credential.authDoor,
  };
}

export function mcpDelegationFreshnessFailure(
  issuedAt: number,
  expiresAt: number,
  nowSeconds: number,
): McpDelegationFreshnessFailure | null {
  if (issuedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return "issued_at_too_new";
  if (issuedAt < nowSeconds - MAX_TTL_SECONDS) return "issued_at_too_old";
  if (expiresAt <= nowSeconds) return "expired";
  if (expiresAt > issuedAt + MAX_TTL_SECONDS) return "ttl_too_long";
  return null;
}

/**
 * A binding-only route has no public address, so no MCP tool call can legitimately
 * be addressed to one. Throwing beats defaulting to a surface: a credential minted
 * for an unaddressable route would be a request nothing may authorize.
 */
function requirePublicSurface(
  operationId: string,
  route: Parameters<typeof publicSurfaceFor>[0],
): PublicSurface {
  const surface = publicSurfaceFor(route);
  if (!surface) {
    throw new Error(
      `contracts: MCP delegation operation "${operationId}" has no public surface to address`,
    );
  }
  return surface;
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
      (value.replayVersion !== undefined && value.replayVersion !== 2) ||
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
      !AuthDoorSchema.safeParse(value.authDoor).success ||
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
