import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The consuming half of the membership-cache invalidation sweep (SPL-532).
 *
 * Membership writes live behind `@splitch/db`, but invalidation needs the shared
 * SESSION_STORE binding owned by each Worker. This test therefore classifies
 * every production caller in both Workers and requires the enclosing block to
 * reach `invalidateMembershipCache` before the mutation. Invalidating first
 * prevents a KV limit fault from following an irreversible D1 write.
 *
 * The match is on each METHOD, not its receiver: destructuring can change a
 * receiver without changing the mutation. The enclosing scope is found by
 * balancing braces, not by looking for `function`, because these trees contain
 * arrow consts and object methods and a declaration-only scan passes vacuously.
 * Those are the same two evasions the Variant freeze sweep previously lost to.
 *
 * Coverage this does NOT give: raw membership SQL inside `@splitch/db`, a new
 * package or Worker outside these two source trees, or the explicit test-only
 * seed modules below. Repository tests cover raw mutation behavior; this sweep
 * covers the production callers that possess the KV binding.
 */

const CONTROL_PLANE_SRC = fileURLToPath(new URL("./", import.meta.url));
const AUTH_SRC = fileURLToPath(new URL("../../auth-api/src/", import.meta.url));
const INVALIDATION = "invalidateMembershipCache";

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
  "auth-api/src/claim-verify-support.ts":
    "invalidates provisional and verified users before a recovered claim transfer",
  "auth-api/src/claim-verify.ts":
    "invalidates provisional and verified users before a claim transfer",
  "auth-api/src/register.ts":
    "invalidates the new user before Organization and App membership creation",
  "control-plane-api/src/app-create-provisioning.ts":
    "invalidates the actor before provisioning the App owner membership",
  "control-plane-api/src/app-delete-holdover.ts":
    "reads App members before the cascade and invalidates every affected user",
  "control-plane-api/src/app-member-handlers.ts":
    "invalidates the affected user before create, role change, and removal",
  "control-plane-api/src/org-create-handler.ts":
    "invalidates the owner before atomic Organization and membership creation",
  "control-plane-api/src/org-handlers.ts":
    "invalidates the affected user before create, role change, and removal",
  "control-plane-api/src/scheduled.ts":
    "reads expired demo members before reaping and invalidates every affected user",
};

const TEST_SUPPORT = new Set([
  "control-plane-api/src/attention-rollup-fixture.ts",
  "control-plane-api/src/attention-rollup-seeds.ts",
  "control-plane-api/src/config-store-fixture-data.ts",
]);

function sourceFiles(root: string, label: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceFiles(join(root, entry.name), label, rel);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [`${label}/src/${rel}`];
  });
}

function pathFor(rel: string): string {
  const [app, , ...rest] = rel.split("/");
  return join(app === "auth-api" ? AUTH_SRC : CONTROL_PLANE_SRC, ...rest);
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
    const files = [
      ...sourceFiles(CONTROL_PLANE_SRC, "control-plane-api"),
      ...sourceFiles(AUTH_SRC, "auth-api"),
    ].filter((rel) => !TEST_SUPPORT.has(rel));
    const calling = files.filter((rel) => callSites(read(rel)).length > 0);

    expect(calling.sort()).toEqual(Object.keys(CALLERS).sort());
  });

  it("reaches invalidation before every mutation call", () => {
    for (const rel of Object.keys(CALLERS)) {
      const source = read(rel);
      const sites = callSites(source);
      expect(sites, `${rel} no longer calls a membership writer`).not.toEqual([]);
      for (const at of sites) {
        const line = source.slice(0, at).split("\n").length;
        const start = blockStart(source, at);
        expect(enclosingBlock(source, at)).toContain(INVALIDATION);
        expect(
          source.slice(start, at),
          `${rel}:${line} does not invalidate membership cache before the mutation`,
        ).toContain(INVALIDATION);
      }
    }
  });
});
