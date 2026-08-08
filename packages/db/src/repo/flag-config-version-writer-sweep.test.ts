import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural sweep: every UPDATE of `flag_configs` bumps `version` (SPL-350).
 *
 * `flag_configs.version` is the documented primary defense against stale-config
 * writes. The compare-and-set in `flag-config-ops.ts` only works when every
 * writer advances the counter. A new UPDATE that forgets the bump compiles,
 * passes review, and silently disables the CAS for every path that races it —
 * the same failure shape the kill-switch copy-drift guard exists to catch.
 *
 * Scan root (asserted below, not assumed): `packages/db/src`. Production Flag
 * Configuration writes live here. Synthetic corrupt-state UPDATEs in test
 * fixtures deliberately skip the bump and sit outside this root on purpose.
 *
 * Out of scope: changing any writer's behavior. A genuine violator under this
 * root fails the sweep and is filed separately.
 */

/** Repo-relative path of the directory this file sweeps. Stated so it is checked. */
const SCAN_ROOT = "packages/db/src";

const SRC = fileURLToPath(new URL("../", import.meta.url));
// packages/db/src → packages/db → packages → repo root
const REPO_ROOT = resolve(SRC, "../../..");

/** Modules known to UPDATE `flag_configs` today. The root must still contain them. */
const KNOWN_WRITER_MODULES = ["repo/flag-config-ops.ts", "repo/flag-variant-approval.ts"] as const;

/**
 * A version assignment that advances the counter. Covers the two shapes in tree
 * today (`current.version + 1` and `sql\`${flagConfigs.version} + 1\``) and any
 * sibling that still ends in `+ 1`.
 */
const VERSION_BUMP = /\bversion\s*:\s*(?:sql`[^`]*\+\s*1[^`]*`|[^\n,}]*\+\s*1)/;

type UpdateSite = {
  file: string;
  line: number;
  kind: "drizzle.update" | "scopedTable.update" | "sql.UPDATE";
  setSource: string;
};

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name), rel);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** Balanced `{ … }` starting at `open`, which must point at `{`. */
function balancedBraces(source: string, open: number): string {
  if (source[open] !== "{") throw new Error(`expected '{' at ${open}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

/** First `{` at or after `from`, skipping whitespace. */
function nextObjectStart(source: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (ch === "{") return i;
    if (!/\s/.test(ch)) {
      throw new Error(`expected object at ${from}, found ${JSON.stringify(ch)}`);
    }
  }
  throw new Error("expected object, found end of file");
}

function nestingDelta(ch: string): number {
  if (ch === "(" || ch === "{" || ch === "[") return 1;
  if (ch === ")" || ch === "}" || ch === "]") return -1;
  return 0;
}

/**
 * Index of the first top-level comma inside a `(…)` call that starts at
 * `callOpenParen`. Throws if the call ends first.
 */
function firstTopLevelComma(source: string, callOpenParen: number): number {
  let depth = 0;
  for (let i = callOpenParen; i < source.length; i++) {
    const ch = source[i] ?? "";
    depth += nestingDelta(ch);
    if (ch === "," && depth === 1) return i;
    if (depth === 0 && ch === ")") throw new Error("update call ended before second arg");
  }
  throw new Error("unbalanced update call");
}

/** Second argument object of `name.update(scope, values, …)`. */
function secondArgObject(source: string, callOpenParen: number): string {
  const comma = firstTopLevelComma(source, callOpenParen);
  return balancedBraces(source, nextObjectStart(source, comma + 1));
}

function drizzleUpdateSites(rel: string, source: string): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const match of source.matchAll(/\.update\(\s*flagConfigs\s*\)/g)) {
    const at = match.index ?? 0;
    const setAt = source.indexOf(".set(", at + match[0].length);
    if (setAt < 0)
      throw new Error(`${rel}:${lineAt(source, at)}: .update(flagConfigs) with no .set(`);
    const setSource = balancedBraces(source, nextObjectStart(source, setAt + ".set(".length));
    sites.push({ file: rel, line: lineAt(source, at), kind: "drizzle.update", setSource });
  }
  return sites;
}

function scopedTableUpdateSites(rel: string, source: string): UpdateSite[] {
  const sites: UpdateSite[] = [];
  // Only the facade bound to `flagConfigs` — not every `*.update(` in the module.
  const bindings = [
    ...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*scopedTable\(\s*db\s*,\s*flagConfigs\s*\)/g),
  ].map((m) => m[1]);
  // makeFlagConfigOps receives the facade as a parameter named flagConfigsTable.
  if (/\bflagConfigsTable\b/.test(source) && !bindings.includes("flagConfigsTable")) {
    bindings.push("flagConfigsTable");
  }
  for (const name of new Set(bindings)) {
    for (const match of source.matchAll(new RegExp(`\\b${name}\\.update\\s*\\(`, "g"))) {
      const at = match.index ?? 0;
      const open = at + match[0].length - 1;
      const setSource = secondArgObject(source, open);
      sites.push({ file: rel, line: lineAt(source, at), kind: "scopedTable.update", setSource });
    }
  }
  return sites;
}

function sqlUpdateSites(rel: string, source: string): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const match of source.matchAll(/UPDATE\s+flag_configs\s+SET\b/gi)) {
    const at = match.index ?? 0;
    // Take a bounded window: enough for the SET clause of a one-shot statement.
    const setSource = source.slice(at, at + 400);
    sites.push({ file: rel, line: lineAt(source, at), kind: "sql.UPDATE", setSource });
  }
  return sites;
}

function updateSitesIn(rel: string): UpdateSite[] {
  const source = read(rel);
  return [
    ...drizzleUpdateSites(rel, source),
    ...scopedTableUpdateSites(rel, source),
    ...sqlUpdateSites(rel, source),
  ];
}

function bumpsVersion(site: UpdateSite): boolean {
  if (site.kind === "sql.UPDATE") {
    return /\bversion\s*=\s*[^\n;]*\+\s*1/i.test(site.setSource);
  }
  return VERSION_BUMP.test(site.setSource);
}

describe("every flag_configs UPDATE bumps version", () => {
  it("states a scan root that actually contains the production writers", () => {
    expect(SCAN_ROOT).toBe("packages/db/src");
    expect(relative(REPO_ROOT, SRC).replaceAll("\\", "/")).toBe(SCAN_ROOT);

    const files = sourceFiles(SRC);
    for (const mod of KNOWN_WRITER_MODULES) {
      expect(files, `${mod} missing from ${SCAN_ROOT}`).toContain(mod);
      const sites = updateSitesIn(mod);
      expect(sites, `${mod} no longer UPDATEs flag_configs`).not.toEqual([]);
    }
  });

  it("leaves no UPDATE site that skips the version bump", () => {
    const sites = sourceFiles(SRC).flatMap(updateSitesIn);

    // Empty would mean the root stopped covering writers — same failure as a
    // quiet violator, just earlier.
    expect(sites.length).toBeGreaterThan(0);

    const violators = sites.filter((site) => !bumpsVersion(site));
    expect(
      violators.map((s) => `${s.file}:${s.line} (${s.kind})`),
      "flag_configs UPDATE without version bump",
    ).toEqual([]);
  });
});
