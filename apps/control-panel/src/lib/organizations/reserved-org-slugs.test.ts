import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isReservedOrganizationSlug } from "@splitch/contracts";
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
 * TanStack Router's flat file convention: dots are path separators and a leading
 * `$` marks a param. `$orgSlug.claim.tsx` is `/:orgSlug/claim`, whose first
 * segment is dynamic and therefore claims no fixed word.
 */
function topLevelStaticSegments(): string[] {
  return readdirSync(routesDir)
    .filter((file) => /\.(tsx|ts)$/.test(file))
    .map((file) => file.replace(/\.(tsx|ts)$/, "").split(".")[0] ?? "")
    .filter((segment) => segment.length > 0)
    .filter((segment) => !segment.startsWith("$") && !segment.startsWith("__"))
    .filter((segment) => segment !== "index");
}

describe("reserved Organization slugs vs the Panel router", () => {
  it("reserves every top-level static route segment", () => {
    const unreserved = topLevelStaticSegments().filter(
      (segment) => !isReservedOrganizationSlug(segment),
    );

    expect(unreserved).toEqual([]);
  });

  it("finds the segments it claims to be checking", () => {
    // Guards the guard: a glob that silently matched nothing would make the
    // assertion above vacuous, and it would pass forever.
    expect(topLevelStaticSegments()).toEqual(expect.arrayContaining(["auth", "claim", "health"]));
  });
});
