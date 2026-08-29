import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The consuming half of the membership-cache invalidation sweep (SPL-532).
 *
 * Membership writes live behind `@splitch/db`, but invalidation needs the shared
 * SESSION_STORE binding owned by the calling Worker. This test therefore scans
 * the repository, classifies every production caller, and requires the enclosing
 * block to reach `mutateMembershipWithCacheInvalidation` around the mutation.
 * Its contract deletes once after the D1 write commits, respecting Workers KV's
 * one-write-per-second limit for each key.
 *
 * The match is on each METHOD, not its receiver: destructuring can change a
 * receiver without changing the mutation. The enclosing scope is found by
 * balancing braces, not by looking for `function`, because these trees contain
 * arrow consts and object methods and a declaration-only scan passes vacuously.
 * Those are the same two evasions the Variant freeze sweep previously lost to.
 *
 * Coverage this does NOT give: raw membership SQL inside `@splitch/db` or the
 * explicit test-only seed modules below. Repository tests cover raw mutation
 * behavior; this sweep covers production repository-method callers everywhere.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CACHE_BOUNDARY = "mutateMembershipWithCacheInvalidation";
const DIRECT_INVALIDATION = "invalidateMembershipCache";
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".output",
  ".turbo",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test",
  "tests",
]);

const MUTATIONS = [
  ".createOrganization(",
  ".createOrgMembership(",
  ".updateOrgMembershipRole(",
  ".deleteOrgMembership(",
  ".createAppMembership(",
  ".updateAppMembership(",
  ".deleteAppMembership(",
  ".deleteAppMemberships(",
  ".deleteAppCascade(",
  ".completeClaim(",
  ".reapExpiredProvisionalOrganizations(",
] as const;

/** Every production module calling a membership writer, with how it invalidates. */
const CALLERS: Record<string, string> = {
  "apps/auth-api/src/claim-verify-support.ts":
    "invalidates provisional and verified users around a recovered claim transfer",
  "apps/auth-api/src/claim-verify.ts":
    "invalidates provisional and verified users around a claim transfer",
  "apps/control-plane-api/src/app-create-provisioning.ts":
    "invalidates the actor around provisioning the App owner membership",
  "apps/control-plane-api/src/app-delete-holdover.ts":
    "reads App members before the cascade and invalidates every affected user around it",
  "apps/control-plane-api/src/app-member-handlers.ts":
    "invalidates the affected user around create, role change, and removal",
  "apps/control-plane-api/src/org-create-handler.ts":
    "invalidates the owner around atomic Organization and membership creation",
  "apps/control-plane-api/src/org-handlers.ts":
    "invalidates the affected user around create, role change, and removal",
  "apps/control-plane-api/src/scheduled.ts":
    "reads expired demo members before reaping and invalidates every affected user around it",
};

// Registration's two membership writes use a freshly minted User id. This is a
// caller-sweep exception, not membership-cache wiring for RegisterDeps.
const FRESH_USER_WRITERS: Record<string, string> = {
  "apps/auth-api/src/register.ts":
    "creates a new User id that cannot have a pre-existing membership cache entry",
};

const TEST_SUPPORT = new Set([
  "apps/cli/src/quickstart-local-harness.ts",
  "apps/control-plane-api/src/attention-rollup-fixture.ts",
  "apps/control-plane-api/src/attention-rollup-seeds.ts",
  "apps/control-plane-api/src/config-store-fixture-data.ts",
]);

function sourceFiles(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(join(root, entry.name), rel);
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

function pathFor(rel: string): string {
  return join(REPO_ROOT, rel);
}

function read(rel: string): string {
  return readFileSync(pathFor(rel), "utf8");
}

function callSites(source: string): number[] {
  return MUTATIONS.flatMap((call) => {
    const found: number[] = [];
    let at = source.indexOf(call);
    while (at >= 0) {
      found.push(at);
      at = source.indexOf(call, at + 1);
    }
    return found;
  }).sort((left, right) => left - right);
}

function blockStart(source: string, at: number): number {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (source[i] === "}") depth += 1;
    else if (source[i] === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  throw new Error("call is not inside any block");
}

function enclosingBlock(source: string, at: number): string {
  const open = blockStart(source, at);
  let nesting = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") nesting += 1;
    else if (source[i] === "}") {
      nesting -= 1;
      if (nesting === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced block");
}

describe("every membership mutation caller invalidates the affected cache", () => {
  it("leaves no production calling module unaccounted for", () => {
    const files = sourceFiles(REPO_ROOT).filter((rel) => !TEST_SUPPORT.has(rel));
    const calling = files.filter((rel) => callSites(read(rel)).length > 0);

    expect(calling.sort()).toEqual(
      [...Object.keys(CALLERS), ...Object.keys(FRESH_USER_WRITERS)].sort(),
    );
  });

  it("routes every cacheable mutation through the post-commit boundary", () => {
    for (const rel of Object.keys(CALLERS)) {
      const source = read(rel);
      const sites = callSites(source);
      expect(sites, `${rel} no longer calls a membership writer`).not.toEqual([]);
      for (const at of sites) {
        const line = source.slice(0, at).split("\n").length;
        const start = blockStart(source, at);
        expect(enclosingBlock(source, at)).toContain(CACHE_BOUNDARY);
        expect(
          source.slice(start, at),
          `${rel}:${line} does not enter the membership cache boundary around the mutation`,
        ).toContain(CACHE_BOUNDARY);
      }
    }
  });

  it("limits no-invalidation callers to freshly minted User ids", () => {
    expect(Object.keys(FRESH_USER_WRITERS)).toEqual(["apps/auth-api/src/register.ts"]);
    for (const rel of Object.keys(FRESH_USER_WRITERS)) {
      expect(read(rel)).not.toContain(CACHE_BOUNDARY);
      expect(read(rel)).not.toContain(DIRECT_INVALIDATION);
    }
  });

  it("does not invalidate when App owner provisioning finds the membership unchanged", () => {
    const source = read("apps/control-plane-api/src/app-create-provisioning.ts");
    const existingBranch = source.slice(
      source.indexOf("if (await deps.repo.identity.getAppMembership"),
      source.indexOf(CACHE_BOUNDARY),
    );
    expect(existingBranch).not.toContain(DIRECT_INVALIDATION);
    expect(existingBranch).not.toContain(CACHE_BOUNDARY);
  });
});
