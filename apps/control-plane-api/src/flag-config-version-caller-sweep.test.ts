import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The consuming half of the flag_configs version-bump sweep (SPL-350).
 *
 * `packages/db/src/repo/flag-config-version-writer-sweep.test.ts` closes over
 * writers INSIDE `@splitch/db`. It cannot see this layer, and this layer is
 * where `makeFlagRepo` exports the raw `flagConfigs` ScopedTable
 * (`packages/db/src/repo/flags.ts`). `ScopedTable.update` is on the public type;
 * a production `repo.flags.flagConfigs.update(...)` here would mutate
 * `flag_configs` without going through `updateFlagConfig` / `replaceTargetingRules`
 * / `renameAvailableVariant`, skip the version bump, and leave the packages/db
 * sweep green — because there was nothing in packages/db to go red.
 *
 * So the rule is enforced where the facade is reached: any call that updates
 * through `flagConfigs` on the repo is a writer this package owns, and today
 * none are allowed. Reads and inserts stay; UPDATEs must go through the ops that
 * bump `version`.
 *
 * Coverage this does NOT give: a brand-new package that imports `@splitch/db`
 * and calls `flagConfigs.update` is outside this tree and outside the db sweep,
 * and would be swept by neither. Stated plainly rather than implied away.
 */

const SRC = fileURLToPath(new URL("./", import.meta.url));

/** Direct seam: `repo.flags.flagConfigs.update(` / `flags.flagConfigs.update(`. */
const DIRECT_UPDATE_PATTERN = String.raw`\.flagConfigs\.update\s*\(`;

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name), rel);
    if (!entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) return [];
    return [rel];
  });
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
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
 * Locals assigned from a `.flagConfigs` read of the repo facade, so
 * `const configs = repo.flags.flagConfigs; configs.update(...)` cannot step
 * over the direct-method match the way destructuring once stepped over
 * `repo.flags.updateVariant(`.
 */
function facadeBindings(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[^;\n]*\.flagConfigs\b/g)) {
    pushBinding(names, match[1]);
  }
  for (const match of source.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*[^;\n]*\bflags\b/g)) {
    pushDestructuredFlagConfigs(names, match[1] ?? "");
  }
  return names;
}

function updateSites(source: string): Array<{ line: number; via: string }> {
  const sites: Array<{ line: number; via: string }> = [];
  for (const match of source.matchAll(new RegExp(DIRECT_UPDATE_PATTERN, "g"))) {
    sites.push({
      line: source.slice(0, match.index ?? 0).split("\n").length,
      via: ".flagConfigs.update(",
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

describe("no control-plane caller updates flag_configs through the raw facade", () => {
  it("leaves no module calling flagConfigs.update", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles(SRC)) {
      const sites = updateSites(read(rel));
      for (const site of sites) {
        offenders.push(`apps/control-plane-api/src/${rel}:${site.line} (${site.via})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
