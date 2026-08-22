import { z } from "zod";
import { appSectionAtPathname } from "./app-shell-navigation";
import { parseCookie, serializeHttpOnlyCookie } from "./session-cookie";

export const LAST_VISITED_COOKIE_NAME = "__last_visited";
const LAST_VISITED_ORG_LIMIT = 8;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

// A same-origin pathname: one leading slash, never protocol-relative, and no
// backslash (browsers rewrite `/\host` to `//host`, which leaves the origin).
const LastVisitedEntrySchema = z.object({
  path: z.string().regex(/^\/(?!\/)[^\\?#\s]*$/),
  appSlug: z.string().min(1),
  env: z.string().min(1).nullable(),
  section: z.string(),
  at: z.number().int().nonnegative(),
});

const LastVisitedScopeSchema = z.object({
  v: z.literal(1),
  actor: z.string().min(1),
  orgs: z
    .record(z.string(), LastVisitedEntrySchema)
    .refine((orgs) => Object.keys(orgs).length <= LAST_VISITED_ORG_LIMIT),
  // The Organization the user was in most recently, whether or not they opened
  // an App there; `/` lands on it. Optional so hints written before it existed
  // still parse.
  lastOrgId: z.string().min(1).optional(),
});

export type LastVisitedEntry = z.infer<typeof LastVisitedEntrySchema>;
export type LastVisitedScope = z.infer<typeof LastVisitedScopeSchema>;

export interface LastVisitedAuthority {
  readonly orgSlug: string;
  readonly apps: ReadonlyArray<{
    readonly appSlug: string;
    readonly environments: ReadonlyArray<{ readonly env: string }>;
  }>;
}

export function lastVisitedEntry(
  appSlug: string,
  env: string | null,
  path: string,
  at: number,
): LastVisitedEntry {
  return {
    path,
    appSlug,
    env,
    section: appSectionAtPathname(path, { appSlug, env }),
    at,
  };
}

/**
 * The hint belongs to one signed-in user: a cookie another user left on this
 * browser (or one forged for a different actor) reads as absent.
 */
export function parseLastVisitedCookie(
  cookieHeader: string | null,
  actorId: string,
): LastVisitedScope | null {
  const raw = parseCookie(cookieHeader).get(LAST_VISITED_COOKIE_NAME);
  if (!raw) return null;

  try {
    const parsed = LastVisitedScopeSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.actor === actorId ? parsed.data : null;
  } catch {
    // This client-controlled cookie is only a navigation hint, not data the
    // screen claims to know, so unreadable input removes the card safely.
    return null;
  }
}

export function recordVisit(
  existing: LastVisitedScope | null,
  actorId: string,
  orgId: string,
  entry: LastVisitedEntry,
): LastVisitedScope {
  const orgs = existing && existing.actor === actorId ? existing.orgs : {};
  const entries = Object.entries({ ...orgs, [orgId]: entry })
    .sort(([leftId, left], [rightId, right]) => right.at - left.at || leftId.localeCompare(rightId))
    .slice(0, LAST_VISITED_ORG_LIMIT);
  return { v: 1, actor: actorId, orgs: Object.fromEntries(entries), lastOrgId: orgId };
}

/** An Organization-level visit (Home) with no App to remember. */
export function recordOrgVisit(
  existing: LastVisitedScope | null,
  actorId: string,
  orgId: string,
): LastVisitedScope {
  const orgs = existing && existing.actor === actorId ? existing.orgs : {};
  return { v: 1, actor: actorId, orgs, lastOrgId: orgId };
}

export function lastVisitedOrgId(value: LastVisitedScope | null): string | null {
  return value?.lastOrgId ?? null;
}

export function entryFor(value: LastVisitedScope | null, orgId: string): LastVisitedEntry | null {
  if (!value) return null;
  const entry = value.orgs[orgId];
  return entry ? entry : null;
}

/**
 * Home re-checks the hint against what the session can reach now: the App must
 * still be one of this Organization's, the Environment must still exist, and
 * the stored path must sit under that scope. A stale or forged entry yields no
 * Continue card rather than a dead or foreign link.
 */
export function authorizedEntry(
  entry: LastVisitedEntry | null,
  authority: LastVisitedAuthority,
): LastVisitedEntry | null {
  if (!entry) return null;
  const app = authority.apps.find((candidate) => candidate.appSlug === entry.appSlug);
  if (!app) return null;
  if (entry.env !== null && !app.environments.some((candidate) => candidate.env === entry.env)) {
    return null;
  }

  const segments = decodedSegments(entry.path);
  if (!segments) return null;
  const scope =
    entry.env === null
      ? [authority.orgSlug, entry.appSlug]
      : [authority.orgSlug, entry.appSlug, entry.env];
  if (entry.env === null && segments.length !== scope.length) return null;
  return scope.every((part, index) => segments[index] === part) ? entry : null;
}

function decodedSegments(path: string): string[] | null {
  try {
    return path
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export function serializeLastVisitedCookie(value: LastVisitedScope) {
  return serializeHttpOnlyCookie(LAST_VISITED_COOKIE_NAME, JSON.stringify(value), {
    maxAge: THIRTY_DAYS_SECONDS,
  });
}

export function formatRelativeTime(now: number, at: number): string {
  const elapsedSeconds = Math.floor(Math.max(0, now - at) / 1_000);
  if (elapsedSeconds < 60) return "just now";

  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
