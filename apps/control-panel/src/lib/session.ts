import {
  clearHttpOnlyCookie,
  generateOpaqueToken,
  isOpaqueToken,
  nowSeconds,
  parseCookie,
  serializeHttpOnlyCookie,
  tokenHash as hashOpaqueToken,
} from "./session-cookie";
import { parseStoredSession } from "./session-schema";

export const SESSION_COOKIE_NAME = "__session";

const SESSION_KEY_PREFIX = "session:";
const MAX_SESSION_TTL_SECONDS = 60 * 60 * 24;
const CURRENT_SESSION_VERSION = 2;

export type OrgRole = "owner" | "admin" | "member";
export type AppRole = "owner" | "admin" | "member" | "viewer";

export interface AppMembership {
  appId: string;
  appSlug: string;
  role: AppRole;
}

export interface OrgMembership {
  orgId: string;
  orgSlug: string;
  orgRole: OrgRole;
  isProvisional: boolean;
  demoExpiresAt: string | null;
  apps: Array<AppMembership>;
}

export interface SessionPrincipal {
  userId: string;
  orgs: Array<OrgMembership>;
  /**
   * True when the User belongs to more Organizations than the session snapshot
   * is allowed to hold, so `orgs` is a prefix rather than the whole set.
   *
   * It travels with the list because a capped list that claims completeness is
   * the "healthy because unknown" shape ADR-0036 forbids: every surface that
   * renders `orgs` has to be able to say so out loud.
   */
  orgsTruncated?: boolean;
}

export interface StoredSession extends SessionPrincipal {
  expiresAt: number;
  /** v1 sessions predate provisional Organization fields and are rehydrated from D1. */
  version?: 1 | 2;
  workosSessionId?: string;
  /** Server-only proof forwarded to Auth API; never included in publicSession. */
  workosAccessToken?: string;
}

export type SessionLoadResult =
  | { ok: true; session: StoredSession; tokenHash: string }
  | { ok: false; reason: "missing" | "tampered" | "expired" | "invalid" };

/**
 * Tags a resync failure that signing in again actually repairs: the callback
 * (`authkit.ts`) reruns `buildSessionPrincipal` with a fresh session, so a
 * fault that is about the session's own identity resolves there. Thrown only
 * at the two sites where that is true (`session-resync.ts`'s missing
 * `workosSessionId`, the TTL guard below) — everything else defaults to "not
 * reauth-fixable" in `resync-remedy.ts`, which is the safe default.
 */
export class RemediableSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemediableSessionError";
  }
  readonly remedy = "reauth" as const;
}

export function publicSession(session: StoredSession): SessionPrincipal {
  return {
    userId: session.userId,
    orgs: session.orgs,
    orgsTruncated: session.orgsTruncated ?? false,
  };
}

export async function createSession(
  kv: KVNamespace,
  session: Omit<StoredSession, "expiresAt"> & { expiresAt?: number },
  now = Date.now(),
): Promise<{ token: string; tokenHash: string; cookie: string; session: StoredSession }> {
  const maxExpiresAt = nowSeconds(now) + MAX_SESSION_TTL_SECONDS;
  const expiresAt = Math.min(session.expiresAt ?? maxExpiresAt, maxExpiresAt);
  const ttl = ttlSeconds(expiresAt, now);
  if (ttl <= 0) {
    throw new Error("control-panel session expires before it can be stored");
  }

  const stored: StoredSession = { ...session, expiresAt, version: CURRENT_SESSION_VERSION };
  assertStoredSession(stored, now);

  const token = generateOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  await kv.put(sessionKey(tokenHash), JSON.stringify(stored), { expirationTtl: ttl });

  return {
    token,
    tokenHash,
    cookie: sessionCookie(token, ttl),
    session: stored,
  };
}

export async function loadSessionFromRequest(
  kv: KVNamespace,
  request: Request,
  now = Date.now(),
): Promise<SessionLoadResult> {
  return loadSessionFromCookieHeader(kv, request.headers.get("cookie"), now);
}

export async function loadSessionFromCookieHeader(
  kv: KVNamespace,
  cookieHeader: string | null,
  now = Date.now(),
): Promise<SessionLoadResult> {
  const token = parseCookie(cookieHeader).get(SESSION_COOKIE_NAME);
  if (!token) {
    return { ok: false, reason: "missing" };
  }
  if (!isOpaqueToken(token)) {
    return { ok: false, reason: "tampered" };
  }

  const tokenHash = await hashOpaqueToken(token);
  const raw = await kv.get(sessionKey(tokenHash), "text");
  if (!raw) {
    return { ok: false, reason: "tampered" };
  }

  const parsed = parseStoredSession(raw, now);
  if (!parsed.ok) {
    await kv.delete(sessionKey(tokenHash));
    return { ok: false, reason: parsed.reason };
  }

  return { ok: true, session: parsed.session, tokenHash };
}

export async function destroySession(
  kv: KVNamespace,
  request: Request,
  now = Date.now(),
): Promise<{ session: StoredSession | null; cookie: string }> {
  const loaded = await loadSessionFromRequest(kv, request, now);
  if (loaded.ok) {
    await kv.delete(sessionKey(loaded.tokenHash));
    return { session: loaded.session, cookie: clearHttpOnlyCookie(SESSION_COOKIE_NAME) };
  }
  return { session: null, cookie: clearHttpOnlyCookie(SESSION_COOKIE_NAME) };
}

export async function refreshSession(
  kv: KVNamespace,
  tokenHash: string,
  session: StoredSession,
  now = Date.now(),
): Promise<void> {
  const stored: StoredSession = { ...session, version: CURRENT_SESSION_VERSION };
  assertStoredSession(stored, now);
  const ttl = ttlSeconds(stored.expiresAt, now);
  if (ttl <= 0) {
    throw new RemediableSessionError("control-panel session expired before it could be refreshed");
  }
  await kv.put(sessionKey(tokenHash), JSON.stringify(stored), { expirationTtl: ttl });
}

export function sessionKey(tokenHash: string): string {
  return `${SESSION_KEY_PREFIX}${tokenHash}`;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return serializeHttpOnlyCookie(SESSION_COOKIE_NAME, token, {
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  });
}

function assertStoredSession(session: StoredSession, now: number): void {
  const parsed = parseStoredSession(JSON.stringify(session), now);
  if (!parsed.ok) {
    throw new Error("invalid control-panel session principal");
  }
}

function ttlSeconds(expiresAt: number, now: number): number {
  return Math.min(MAX_SESSION_TTL_SECONDS, expiresAt - nowSeconds(now));
}
