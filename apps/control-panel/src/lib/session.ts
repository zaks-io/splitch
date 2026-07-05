import {
  clearHttpOnlyCookie,
  generateOpaqueToken,
  isOpaqueToken,
  nowSeconds,
  parseCookie,
  serializeHttpOnlyCookie,
  tokenHash as hashOpaqueToken,
} from "./session-cookie";

export const SESSION_COOKIE_NAME = "__session";

const SESSION_KEY_PREFIX = "session:";
const MAX_SESSION_TTL_SECONDS = 60 * 60 * 24;

const ORG_ROLES = new Set(["owner", "admin", "member"]);
const APP_ROLES = new Set(["owner", "admin", "member", "viewer"]);
const STORED_SESSION_KEYS = new Set(["userId", "orgs", "expiresAt", "workosSessionId"]);
const ORG_MEMBERSHIP_KEYS = new Set(["orgId", "orgSlug", "orgRole", "apps"]);
const APP_MEMBERSHIP_KEYS = new Set(["appId", "appSlug", "role"]);

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
  apps: Array<AppMembership>;
}

export interface SessionPrincipal {
  userId: string;
  orgs: Array<OrgMembership>;
}

export interface StoredSession extends SessionPrincipal {
  expiresAt: number;
  workosSessionId?: string;
}

export type SessionLoadResult =
  | { ok: true; session: StoredSession; tokenHash: string }
  | { ok: false; reason: "missing" | "tampered" | "expired" | "invalid" };

export function publicSession(session: StoredSession): SessionPrincipal {
  return {
    userId: session.userId,
    orgs: session.orgs,
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

  const stored: StoredSession = { ...session, expiresAt };
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

export function sessionKey(tokenHash: string): string {
  return `${SESSION_KEY_PREFIX}${tokenHash}`;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return serializeHttpOnlyCookie(SESSION_COOKIE_NAME, token, {
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  });
}

function parseStoredSession(
  raw: string,
  now: number,
): { ok: true; session: StoredSession } | { ok: false; reason: "expired" | "invalid" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "invalid" };
  }

  if (!hasOnlyKeys(parsed, STORED_SESSION_KEYS)) {
    return { ok: false, reason: "invalid" };
  }

  const session = parsed as Partial<StoredSession>;
  if (!isStoredSession(session)) {
    return { ok: false, reason: "invalid" };
  }

  if (session.expiresAt <= nowSeconds(now)) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, session };
}

function assertStoredSession(session: StoredSession, now: number): void {
  const parsed = parseStoredSession(JSON.stringify(session), now);
  if (!parsed.ok) {
    throw new Error("invalid control-panel session principal");
  }
}

function isStoredSession(value: Partial<StoredSession>): value is StoredSession {
  return (
    isNonEmptyString(value.userId) &&
    Number.isInteger(value.expiresAt) &&
    (value.workosSessionId === undefined || isNonEmptyString(value.workosSessionId)) &&
    Array.isArray(value.orgs) &&
    value.orgs.every(isOrgMembership)
  );
}

function isOrgMembership(value: unknown): value is OrgMembership {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ORG_MEMBERSHIP_KEYS)) {
    return false;
  }
  const candidate = value as Partial<OrgMembership>;
  return (
    isNonEmptyString(candidate.orgId) &&
    isNonEmptyString(candidate.orgSlug) &&
    typeof candidate.orgRole === "string" &&
    ORG_ROLES.has(candidate.orgRole) &&
    Array.isArray(candidate.apps) &&
    candidate.apps.every(isAppMembership)
  );
}

function isAppMembership(value: unknown): value is AppMembership {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, APP_MEMBERSHIP_KEYS)) {
    return false;
  }
  const candidate = value as Partial<AppMembership>;
  return (
    isNonEmptyString(candidate.appId) &&
    isNonEmptyString(candidate.appSlug) &&
    typeof candidate.role === "string" &&
    APP_ROLES.has(candidate.role)
  );
}

function ttlSeconds(expiresAt: number, now: number): number {
  return Math.min(MAX_SESSION_TTL_SECONDS, expiresAt - nowSeconds(now));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
