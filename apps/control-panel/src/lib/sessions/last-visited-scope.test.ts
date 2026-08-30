import { describe, expect, it } from "vitest";
import {
  authorizedEntry,
  entryFor,
  formatRelativeTime,
  LAST_VISITED_COOKIE_NAME,
  type LastVisitedScope,
  lastVisitedEntry,
  lastVisitedOrgId,
  parseLastVisitedCookie,
  recordOrgVisit,
  recordVisit,
  serializeLastVisitedCookie,
} from "#lib/sessions/last-visited-scope";

const entry = {
  path: "/acme-labs/checkout-api/dev/flags",
  appSlug: "checkout-api",
  env: "dev",
  section: "flags",
  at: 1_000,
} as const;

describe("last-visited scope cookie", () => {
  const encoded = (value: unknown) =>
    `${LAST_VISITED_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(value))}`;

  it("parses a valid cookie and ignores missing, malformed, or wrong-version hints", () => {
    const value: LastVisitedScope = { v: 1, actor: "user_1", orgs: { org_1: entry } };

    expect(parseLastVisitedCookie(encoded(value), "user_1")).toEqual(value);
    expect(parseLastVisitedCookie(null, "user_1")).toBeNull();
    expect(parseLastVisitedCookie(`${LAST_VISITED_COOKIE_NAME}=not-json`, "user_1")).toBeNull();
    expect(
      parseLastVisitedCookie(
        encoded({
          v: 1,
          actor: "user_1",
          orgs: { org_1: { ...entry, path: "//outside.example" } },
        }),
        "user_1",
      ),
    ).toBeNull();
    expect(
      parseLastVisitedCookie(
        encoded({
          v: 1,
          actor: "user_1",
          orgs: { org_1: { ...entry, path: "/\\outside.example" } },
        }),
        "user_1",
      ),
    ).toBeNull();
    expect(
      parseLastVisitedCookie(encoded({ v: 2, actor: "user_1", orgs: {} }), "user_1"),
    ).toBeNull();
  });

  it("reads as absent for another user and when it names more than eight Organizations", () => {
    const value: LastVisitedScope = { v: 1, actor: "user_1", orgs: { org_1: entry } };
    expect(parseLastVisitedCookie(encoded(value), "user_2")).toBeNull();

    const orgs = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`org_${index}`, { ...entry, at: index }]),
    );
    expect(parseLastVisitedCookie(encoded({ v: 1, actor: "user_1", orgs }), "user_1")).toBeNull();
  });

  it("records one entry per Organization and drops the oldest beyond eight", () => {
    let value: LastVisitedScope | null = null;
    for (let index = 0; index < 9; index += 1) {
      value = recordVisit(value, "user_1", `org_${index}`, { ...entry, at: index });
    }

    if (!value) throw new Error("expected recorded visits");
    expect(value.actor).toBe("user_1");
    expect(Object.keys(value.orgs)).toHaveLength(8);
    expect(entryFor(value, "org_0")).toBeNull();
    expect(entryFor(value, "org_8")?.at).toBe(8);
  });

  it("replaces the current Organization entry and discards another user's history", () => {
    const first = recordVisit(null, "user_1", "org_1", entry);
    const next = recordVisit(first, "user_1", "org_1", { ...entry, path: "/next", at: 2_000 });
    expect(Object.keys(next.orgs)).toEqual(["org_1"]);
    expect(entryFor(next, "org_1")?.path).toBe("/next");

    const other = recordVisit(next, "user_2", "org_2", entry);
    expect(other).toEqual({ v: 1, actor: "user_2", orgs: { org_2: entry }, lastOrgId: "org_2" });
  });

  it("remembers the last Organization from App visits and from Home alone", () => {
    expect(lastVisitedOrgId(null)).toBeNull();

    const appVisit = recordVisit(null, "user_1", "org_1", entry);
    expect(lastVisitedOrgId(appVisit)).toBe("org_1");

    const homeVisit = recordOrgVisit(appVisit, "user_1", "org_2");
    expect(lastVisitedOrgId(homeVisit)).toBe("org_2");
    expect(entryFor(homeVisit, "org_1")).toEqual(entry);

    const other = recordOrgVisit(homeVisit, "user_2", "org_3");
    expect(other).toEqual({ v: 1, actor: "user_2", orgs: {}, lastOrgId: "org_3" });

    const legacy = { v: 1, actor: "user_1", orgs: { org_1: entry } };
    expect(parseLastVisitedCookie(encoded(legacy), "user_1")).toEqual(legacy);
    expect(lastVisitedOrgId(parseLastVisitedCookie(encoded(legacy), "user_1"))).toBeNull();
  });

  it("derives registry sections from Environment paths and Flags for App home", () => {
    expect(lastVisitedEntry("checkout-api", "dev", entry.path, 1_000).section).toBe("flags");
    expect(
      lastVisitedEntry("checkout-api", "dev", "/acme-labs/checkout-api/dev", 1_000).section,
    ).toBe("");
    expect(lastVisitedEntry("checkout-api", null, "/acme-labs/checkout-api", 1_000).section).toBe(
      "flags",
    );
    expect(() => lastVisitedEntry("checkout-api", null, "/acme-labs/other-api", 1_000)).toThrow(
      "does not match its resolved App scope",
    );
  });

  it("serializes with the shared HttpOnly cookie attributes and a 30-day lifetime", () => {
    const cookie = serializeLastVisitedCookie({ v: 1, actor: "user_1", orgs: { org_1: entry } });

    expect(cookie).toContain(`${LAST_VISITED_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax; Path=/");
    expect(cookie).toContain("Max-Age=2592000");
  });
});

describe("authorized Continue entry", () => {
  const authority = {
    orgSlug: "acme-labs",
    apps: [{ appSlug: "checkout-api", environments: [{ env: "dev" }] }],
  };

  it("keeps an entry whose App, Environment, and path are still reachable", () => {
    expect(authorizedEntry(entry, authority)).toEqual(entry);
    expect(
      authorizedEntry({ ...entry, env: null, path: "/acme-labs/checkout-api" }, authority),
    ).not.toBeNull();
    expect(
      authorizedEntry(
        { ...entry, path: "/acme-labs/checkout-api/dev/experiments/exp_1" },
        authority,
      ),
    ).not.toBeNull();
  });

  it("drops a missing, stale, or out-of-scope entry", () => {
    expect(authorizedEntry(null, authority)).toBeNull();
    expect(authorizedEntry({ ...entry, appSlug: "other-api" }, authority)).toBeNull();
    expect(authorizedEntry({ ...entry, env: "prod" }, authority)).toBeNull();
    expect(
      authorizedEntry({ ...entry, path: "/acme-labs/other-api/dev/flags" }, authority),
    ).toBeNull();
    expect(
      authorizedEntry({ ...entry, path: "/evil-org/checkout-api/dev/flags" }, authority),
    ).toBeNull();
    expect(
      authorizedEntry({ ...entry, env: null, path: "/acme-labs/checkout-api/dev" }, authority),
    ).toBeNull();
    expect(authorizedEntry({ ...entry, path: "/acme-labs/%E0%A4%A" }, authority)).toBeNull();
  });
});

describe("relative visit time", () => {
  it.each([
    [30_000, "just now"],
    [60_000, "1 minute ago"],
    [5 * 60_000, "5 minutes ago"],
    [60 * 60_000, "1 hour ago"],
    [6 * 60 * 60_000, "6 hours ago"],
    [24 * 60 * 60_000, "1 day ago"],
    [3 * 24 * 60 * 60_000, "3 days ago"],
  ])("formats %i milliseconds", (elapsed, expected) => {
    expect(formatRelativeTime(10_000_000, 10_000_000 - elapsed)).toBe(expected);
  });
});
