import { z } from "zod";
import { appSectionAtPathname } from "./app-shell-navigation";
import { parseCookie, serializeHttpOnlyCookie } from "./session-cookie";

export const LAST_VISITED_COOKIE_NAME = "__last_visited";
const LAST_VISITED_ORG_LIMIT = 8;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

const LastVisitedEntrySchema = z.object({
  path: z.string().regex(/^\/(?!\/)/),
  appSlug: z.string().min(1),
  env: z.string().min(1).nullable(),
  section: z.string(),
  at: z.number().int().nonnegative(),
});

const LastVisitedScopeSchema = z.object({
  v: z.literal(1),
  orgs: z.record(z.string(), LastVisitedEntrySchema),
});

export type LastVisitedEntry = z.infer<typeof LastVisitedEntrySchema>;
export type LastVisitedScope = z.infer<typeof LastVisitedScopeSchema>;

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

export function parseLastVisitedCookie(cookieHeader: string | null): LastVisitedScope | null {
  const raw = parseCookie(cookieHeader).get(LAST_VISITED_COOKIE_NAME);
  if (!raw) return null;

  try {
    const parsed = LastVisitedScopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // This client-controlled cookie is only a navigation hint, not data the
    // screen claims to know, so unreadable input removes the card safely.
    return null;
  }
}

export function recordVisit(
  existing: LastVisitedScope | null,
  orgId: string,
  entry: LastVisitedEntry,
): LastVisitedScope {
  const orgs = existing ? existing.orgs : {};
  const entries = Object.entries({ ...orgs, [orgId]: entry })
    .sort(([leftId, left], [rightId, right]) => right.at - left.at || leftId.localeCompare(rightId))
    .slice(0, LAST_VISITED_ORG_LIMIT);
  return { v: 1, orgs: Object.fromEntries(entries) };
}

export function entryFor(value: LastVisitedScope | null, orgId: string): LastVisitedEntry | null {
  if (!value) return null;
  const entry = value.orgs[orgId];
  return entry ? entry : null;
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
