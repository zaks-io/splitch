import { describe, expect, it } from "vitest";
import {
  entryFor,
  formatRelativeTime,
  lastVisitedEntry,
  LAST_VISITED_COOKIE_NAME,
  parseLastVisitedCookie,
  recordVisit,
  serializeLastVisitedCookie,
  type LastVisitedScope,
} from "./last-visited-scope";

const entry = {
  path: "/acme-labs/checkout-api/dev/flags",
  appSlug: "checkout-api",
  env: "dev",
  section: "flags",
  at: 1_000,
} as const;

describe("last-visited scope cookie", () => {
  it("parses a valid cookie and ignores missing, malformed, or wrong-version hints", () => {
    const value: LastVisitedScope = { v: 1, orgs: { org_1: entry } };
    const encoded = encodeURIComponent(JSON.stringify(value));

    expect(parseLastVisitedCookie(`${LAST_VISITED_COOKIE_NAME}=${encoded}`)).toEqual(value);
    expect(parseLastVisitedCookie(null)).toBeNull();
    expect(parseLastVisitedCookie(`${LAST_VISITED_COOKIE_NAME}=not-json`)).toBeNull();
    expect(
      parseLastVisitedCookie(
        `${LAST_VISITED_COOKIE_NAME}=${encodeURIComponent(
          JSON.stringify({
            v: 1,
            orgs: { org_1: { ...entry, path: "//outside.example" } },
          }),
        )}`,
      ),
    ).toBeNull();
    expect(
      parseLastVisitedCookie(
        `${LAST_VISITED_COOKIE_NAME}=${encodeURIComponent(JSON.stringify({ v: 2, orgs: {} }))}`,
      ),
    ).toBeNull();
  });

  it("records one entry per Organization and drops the oldest beyond eight", () => {
    let value: LastVisitedScope | null = null;
    for (let index = 0; index < 9; index += 1) {
      value = recordVisit(value, `org_${index}`, { ...entry, at: index });
    }

    if (!value) throw new Error("expected recorded visits");
    expect(Object.keys(value.orgs)).toHaveLength(8);
    expect(entryFor(value, "org_0")).toBeNull();
    expect(entryFor(value, "org_8")?.at).toBe(8);
  });

  it("replaces the current Organization entry", () => {
    const first = recordVisit(null, "org_1", entry);
    const next = recordVisit(first, "org_1", { ...entry, path: "/next", at: 2_000 });

    expect(Object.keys(next.orgs)).toEqual(["org_1"]);
    expect(entryFor(next, "org_1")?.path).toBe("/next");
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
    const cookie = serializeLastVisitedCookie({ v: 1, orgs: { org_1: entry } });

    expect(cookie).toContain(`${LAST_VISITED_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax; Path=/");
    expect(cookie).toContain("Max-Age=2592000");
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
