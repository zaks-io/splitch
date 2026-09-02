import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isReservedOrganizationSlug, SlugSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";

/**
 * The reserved-slug list lives in @splitch/contracts (the create path validates
 * against it), but the routes it protects live HERE. Nothing tied the two
 * together, so the list was written against an imagined route table and missed
 * `claim` — the claim-ceremony segment — while reserving words the Panel does
 * not route on at all.
 *
 * This asserts the direction that actually matters: every top-level static
 * segment the router owns must be reserved. The converse is deliberately NOT
 * asserted, because the list is a superset of words the Panel may claim later.
 */

const routesDir = fileURLToPath(new URL("../../routes", import.meta.url));

/**
 * TanStack Router's flat file convention, as it bears on shadowing:
 *
 * - dots separate path segments, and `[.]` is an escaped literal dot, so
 *   `robots[.]txt.ts` is the single segment `robots.txt`;
 * - `$` marks a param, so `$orgSlug.claim.tsx` claims no fixed word;
 * - a leading `_` marks a pathless layout, which contributes no URL segment of
 *   its own, so `_authed.dashboard.tsx` routes `/dashboard` and the word that
 *   can be shadowed is `dashboard`;
 * - a trailing `_` un-nests from the parent layout without changing the URL, so
 *   `pricing_.plans.tsx` routes `/pricing/plans` and shadows `pricing`.
 *
 * Both underscore forms are already in use in this directory, and both hide the
 * shadowed word behind a spelling no Org slug can match, so neither may be
 * dropped on the way to the reservation check.
 */
function topLevelStaticSegments(): string[] {
  return readdirSync(routesDir)
    .filter((file) => /\.(tsx|ts)$/.test(file))
    .map((file) => topLevelUrlSegment(file.replace(/\.(tsx|ts)$/, "")))
    .filter((segment) => segment.length > 0)
    .filter((segment) => !segment.startsWith("$"))
    .filter((segment) => segment !== "index");
}

const ESCAPED_DOT = "[.]";
const ESCAPED_DOT_PLACEHOLDER = "\u0000";

/** The first segment this route file contributes to the URL, or `""` for none. */
function topLevelUrlSegment(routeName: string): string {
  const segments = routeName
    .replaceAll(ESCAPED_DOT, ESCAPED_DOT_PLACEHOLDER)
    .split(".")
    .map((segment) => segment.replaceAll(ESCAPED_DOT_PLACEHOLDER, "."))
    .filter((segment) => !segment.startsWith("_"));
  return segments[0]?.replace(/_$/, "") ?? "";
}

/** Only a segment a slug can actually spell is capable of shadowing a route. */
function slugShapedSegments(): string[] {
  return topLevelStaticSegments().filter((segment) => SlugSchema.safeParse(segment).success);
}

describe("reserved Organization slugs vs the Panel router", () => {
  it("reserves every top-level static route segment an Org could be slugged as", () => {
    // A segment no slug can spell (`robots.txt` carries a dot) cannot shadow a
    // route, so only slug-shaped segments have to be reserved. SlugSchema, not
    // OrganizationSlugSchema: the latter already rejects reserved words, which
    // would make this vacuous.
    const unreserved = slugShapedSegments().filter(
      (segment) => !isReservedOrganizationSlug(segment),
    );

    expect(unreserved).toEqual([]);
  });

  it("finds the segments it claims to be checking", () => {
    // Guards the guard twice over: a glob that matched nothing, or a slug filter
    // that rejected ordinary route words, would each empty the checked list and
    // pass forever. So assert the raw scan AND the filtered list it checks.
    expect(topLevelStaticSegments()).toEqual(
      expect.arrayContaining(["auth", "claim", "health", "robots.txt"]),
    );
    expect(slugShapedSegments()).toEqual(
      expect.arrayContaining(["auth", "claim", "health", "kitchen-sink"]),
    );
  });

  it("reads the underscore conventions as the URL segments they produce", () => {
    expect(topLevelUrlSegment("pricing_.plans")).toBe("pricing");
    expect(topLevelUrlSegment("_authed.dashboard")).toBe("dashboard");
    expect(topLevelUrlSegment("robots[.]txt")).toBe("robots.txt");
    expect(topLevelUrlSegment("__root")).toBe("");
  });
});
