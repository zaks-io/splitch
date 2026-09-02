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
 * TanStack Router's flat file convention: dots are path separators, `[.]` is an
 * escaped literal dot, and a leading `$` marks a param. `$orgSlug.claim.tsx` is
 * `/:orgSlug/claim`, whose first segment is dynamic and therefore claims no
 * fixed word; `robots[.]txt.ts` is the single segment `robots.txt`.
 */
function topLevelStaticSegments(): string[] {
  return readdirSync(routesDir)
    .filter((file) => /\.(tsx|ts)$/.test(file))
    .map((file) => firstPathSegment(file.replace(/\.(tsx|ts)$/, "")))
    .filter((segment) => segment.length > 0)
    .filter((segment) => !segment.startsWith("$") && !segment.startsWith("__"))
    .filter((segment) => segment !== "index");
}

const ESCAPED_DOT = "[.]";
const ESCAPED_DOT_PLACEHOLDER = "\u0000";

function firstPathSegment(routeName: string): string {
  return (
    routeName
      .replaceAll(ESCAPED_DOT, ESCAPED_DOT_PLACEHOLDER)
      .split(".")[0]
      ?.replaceAll(ESCAPED_DOT_PLACEHOLDER, ".") ?? ""
  );
}

describe("reserved Organization slugs vs the Panel router", () => {
  it("reserves every top-level static route segment an Org could be slugged as", () => {
    // A segment no slug can spell (`robots.txt` carries a dot) cannot shadow a
    // route, so only slug-shaped segments have to be reserved. SlugSchema, not
    // OrganizationSlugSchema: the latter already rejects reserved words, which
    // would make this vacuous.
    const unreserved = topLevelStaticSegments()
      .filter((segment) => SlugSchema.safeParse(segment).success)
      .filter((segment) => !isReservedOrganizationSlug(segment));

    expect(unreserved).toEqual([]);
  });

  it("finds the segments it claims to be checking", () => {
    // Guards the guard: a glob that silently matched nothing would make the
    // assertion above vacuous, and it would pass forever.
    expect(topLevelStaticSegments()).toEqual(
      expect.arrayContaining(["auth", "claim", "health", "robots.txt"]),
    );
  });
});
