import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The consuming half of the flag_configs version-bump sweep (SPL-350).
 *
 * `packages/db/src/repo/flag-config-version-writer-sweep.test.ts` closes over
 * writers INSIDE `@splitch/db`. It cannot see this layer, and this layer is
 * where `makeFlagRepo` exports the raw `flagConfigs` ScopedTable
 * (`packages/db/src/repo/flags.ts`). `ScopedTable.update` is on the public type;
 * a production `repo.flags.flagConfigs.update(...)` in any package that holds a
 * Repository would mutate `flag_configs` without going through `updateFlagConfig`
 * / `replaceTargetingRules` / `renameAvailableVariant`, skip the version bump,
 * and leave the packages/db sweep green.
 *
 * Scan root (asserted below): the repo. Every module that names `.flagConfigs`
 * must be classified — the same closure B1 took for `packages/db`. Reads and
 * inserts stay; UPDATEs must go through the ops that bump `version`. Control
 * Panel, CLI, Auth API, and control-plane harnesses under `test/` are in scope;
 * they already hold live Repository objects.
 */

/** Repo-relative path of the directory this file sweeps. Stated so it is checked. */
const SCAN_ROOT = ".";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const THIS_FILE = "apps/control-plane-api/src/flag-config-version-caller-sweep.test.ts";

/**
 * Every module allowed to name `.flagConfigs`, with why it is not an UPDATE
 * through the raw facade. A new module fails the sweep no matter how it writes.
 */
const FLAG_CONFIGS_FACADE_MODULES: Record<string, string> = {
  [THIS_FILE]: "this sweep; names the seam in assertions only",
  "packages/db/src/repo/flag-config-version-writer-sweep.test.ts":
    "writer-sweep docblock points at this companion",
  "apps/control-plane-api/src/app-delete-tree.ts": "findMany only",
  "apps/control-plane-api/src/config-store-fixture-data.ts": "seed insert",
  "apps/control-plane-api/src/flag-config-lifecycle.ts": "findMany only",
  "apps/control-plane-api/src/panel-overview-flag-bounds.test.ts": "test seed insert",
  "apps/control-plane-api/test/app-delete-cascade-fixture.ts": "fixture insert",
  "apps/control-plane-api/test/app-environment-delete-guards.test.ts": "test seed insert",
  "apps/control-plane-api/test/approval-harness.ts": "harness insert",
  "apps/control-plane-api/test/approval-organization-b.ts": "harness insert",
  "apps/control-plane-api/test/config-store-promotion.test.ts": "test seed insert",
  "apps/control-plane-api/test/flag-config-lifecycle-harness.ts": "harness findMany",
  "apps/control-plane-api/test/flag-config-lifecycle.test.ts": "test findMany",
};

/** Direct seam call shape. Built so this file's own source does not contain it contiguously. */
const DIRECT_UPDATE_PATTERN = String.raw`\.flagConfigs\.update\s*\(`;

function shouldSkip(relativePath: string): boolean {
  return (
    relativePath.startsWith("node_modules/") ||
    relativePath.includes("/node_modules/") ||
    relativePath.startsWith("dist/") ||
    relativePath.includes("/dist/") ||
    relativePath.startsWith(".git/") ||
    relativePath.includes("/coverage/") ||
    relativePath.includes("/.turbo/") ||
    relativePath.includes("/.wrangler/") ||
    relativePath.includes("/.output/") ||
    relativePath.endsWith(".snap")
  );
}

function walk(dir: string, visit: (absolutePath: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === ".git" ||
        entry === "dist" ||
        entry === "coverage" ||
        entry === ".turbo" ||
        entry === ".wrangler" ||
        entry === ".output"
      ) {
        continue;
      }
      walk(absolutePath, visit);
      continue;
    }
    visit(absolutePath);
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  walk(REPO_ROOT, (absolutePath) => {
    if (!absolutePath.endsWith(".ts") && !absolutePath.endsWith(".tsx")) return;
    const relativePath = relative(REPO_ROOT, absolutePath).replaceAll("\\", "/");
    if (shouldSkip(relativePath)) return;
    files.push(relativePath);
  });
  return files.sort();
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function namesFacade(source: string): boolean {
  return /\.flagConfigs\b/.test(source);
}

function pushBinding(names: string[], name: string | undefined): void {
  if (name) names.push(name);
}

function pushDestructuredFlagConfigs(names: string[], block: string): void {
  for (const part of block.split(",")) {
    const trimmed = part.trim();
    const aliased = trimmed.match(/^flagConfigs\s+as\s+(\w+)$/);
    if (aliased) pushBinding(names, aliased[1]);
    else if (trimmed === "flagConfigs") names.push("flagConfigs");
  }
}

/**
 * Locals assigned from a `.flagConfigs` read of the repo facade — not from an
 * `await …findMany(...)` (that is a row array). Anchored to a non-await,
 * non-call RHS so `const configs = await repo.flags.flagConfigs.findMany(scope)`
 * is not registered as a facade.
 */
function facadeBindings(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /(?:const|let)\s+(\w+)\s*=\s*(?!await\b)([^;\n]*?)\.flagConfigs\b(?!\s*[.(`])/g,
  )) {
    const rhsPrefix = match[2] ?? "";
    if (rhsPrefix.includes("(")) continue;
    pushBinding(names, match[1]);
  }
  for (const match of source.matchAll(
    /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?!await\b)[^;\n]*\bflags\b/g,
  )) {
    pushDestructuredFlagConfigs(names, match[1] ?? "");
  }
  return names;
}

function updateSites(source: string): Array<{ line: number; via: string }> {
  const sites: Array<{ line: number; via: string }> = [];
  for (const match of source.matchAll(new RegExp(DIRECT_UPDATE_PATTERN, "g"))) {
    sites.push({
      line: source.slice(0, match.index ?? 0).split("\n").length,
      via: [".flagConfigs", ".update("].join(""),
    });
  }
  for (const name of facadeBindings(source)) {
    for (const match of source.matchAll(new RegExp(`\\b${name}\\.update\\s*\\(`, "g"))) {
      sites.push({
        line: source.slice(0, match.index ?? 0).split("\n").length,
        via: `${name}.update(`,
      });
    }
  }
  return sites;
}

describe("no caller updates flag_configs through the raw facade", () => {
  it("states a scan root that covers every package holding a Repository", () => {
    expect(SCAN_ROOT).toBe(".");
    expect(sourceFiles().length).toBeGreaterThan(0);
    // Harnesses under test/ name the facade and must be in the classification.
    expect(FLAG_CONFIGS_FACADE_MODULES).toHaveProperty(
      "apps/control-plane-api/test/flag-config-lifecycle-harness.ts",
    );
    expect(FLAG_CONFIGS_FACADE_MODULES).toHaveProperty(
      "apps/control-plane-api/test/approval-harness.ts",
    );
    expect(FLAG_CONFIGS_FACADE_MODULES).toHaveProperty(
      "apps/control-plane-api/test/app-delete-cascade-fixture.ts",
    );
  });

  it("leaves no module naming .flagConfigs unaccounted for", () => {
    const touching = sourceFiles().filter((rel) => namesFacade(read(rel)));
    expect(touching.sort()).toEqual(Object.keys(FLAG_CONFIGS_FACADE_MODULES).sort());
  });

  it("leaves no module calling flagConfigs.update", () => {
    const offenders: string[] = [];
    for (const rel of Object.keys(FLAG_CONFIGS_FACADE_MODULES)) {
      if (rel === THIS_FILE) continue;
      for (const site of updateSites(read(rel))) {
        offenders.push(`${rel}:${site.line} (${site.via})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
