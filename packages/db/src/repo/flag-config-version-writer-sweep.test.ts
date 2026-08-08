import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  balancedBraces,
  bumpWins,
  chainedSetAt,
  drizzleUpdatePattern,
  enclosingTemplateLiteral,
  insertArgIsFlagConfigs,
  insertArgOnUpsertChain,
  isBumpExpr,
  lineAt,
  nextObjectStart,
  scopedFacades,
  secondArgObject,
  tableAliases,
  type UpdateSite,
} from "./flag-config-version-writer-sweep-lib";

/**
 * Structural sweep: every UPDATE of `flag_configs` bumps `version` (SPL-350).
 *
 * `flag_configs.version` is the documented primary defense against stale-config
 * writes. The compare-and-set in `flag-config-ops.ts` only works when every
 * writer advances the counter. A new UPDATE that forgets the bump compiles,
 * passes review, and silently disables the CAS for every path that races it.
 *
 * Scan root (asserted below): `packages/db/src/repo`. That is the only directory
 * that can write the table: the exported `repo.flags.flagConfigs` facade is
 * narrowed to findMany/findOne/insert, so callers outside this package cannot
 * call `.update`. Writers here are checked for every UPDATE/UPSERT shape, and
 * the bump must be an allowlisted derivation that WINS after spreads.
 */

/** Repo-relative path of the directory this file sweeps. Stated so it is checked. */
const SCAN_ROOT = "packages/db/src/repo";

const SRC = fileURLToPath(new URL("./", import.meta.url));
const REPO_ROOT = resolve(SRC, "../../../..");

/**
 * Every module under the scan root allowed to name `flagConfigs` / `flag_configs`,
 * with why it is not itself an UPDATE writer — or `"writer"` when it is. A new
 * module fails the sweep no matter how it writes.
 */
const FLAG_CONFIGS_MODULES: Record<string, "writer" | string> = {
  "scope.ts": "EnvScope docs name the table in prose only",
  "flag-variant-run-freeze.ts": "freeze lookup names the column in prose only",
  "test-d1-pool.ts": "test-pool cleanup table-name list; no UPDATE",
  "identity-demo-reaper.ts": "DELETE cascade table-name list; no UPDATE",
  "flags.ts":
    "wires scopedTable and DELETE cascade; UPDATEs go through makeFlagConfigOps. Exported flagConfigs is findMany/findOne/insert only",
  "flag-config-ops.ts": "writer",
  "flag-variant-approval.ts": "writer",
  "flag-config-version-writer-sweep-lib.ts": "structural sweep helpers; no production UPDATE",
};

const WRITER_MODULES = Object.entries(FLAG_CONFIGS_MODULES)
  .filter(([, kind]) => kind === "writer")
  .map(([rel]) => rel);

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

function repoPath(rel: string): string {
  return `${SCAN_ROOT}/${rel}`;
}

function namesFlagConfigs(source: string): boolean {
  return /\bflagConfigs\b|\bflag_configs\b/.test(source);
}

function drizzleUpdateSites(rel: string, source: string, aliases: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const alias of aliases) {
    for (const match of source.matchAll(drizzleUpdatePattern(alias))) {
      const at = match.index ?? 0;
      const setAt = chainedSetAt(source, at + match[0].length);
      if (setAt < 0) {
        throw new Error(
          `${repoPath(rel)}:${lineAt(source, at)}: .update(${alias}) with no chained .set(`,
        );
      }
      const setSource = balancedBraces(source, nextObjectStart(source, setAt + ".set(".length));
      sites.push({ file: rel, line: lineAt(source, at), kind: "drizzle.update", setSource });
    }
  }
  return sites;
}

function scopedTableUpdateSites(rel: string, source: string, facades: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const name of facades) {
    for (const match of source.matchAll(new RegExp(`\\b${name}\\.update\\s*\\(`, "g"))) {
      const at = match.index ?? 0;
      const open = at + match[0].length - 1;
      const setSource = secondArgObject(source, open);
      sites.push({ file: rel, line: lineAt(source, at), kind: "scopedTable.update", setSource });
    }
  }
  return sites;
}

/**
 * `insert(alias).…onConflictDoUpdate({ set })` is an UPDATE of an existing row.
 * Must be chained to `.insert(…)`; a split-statement upsert fails loud rather
 * than being silently skipped.
 */
function upsertSites(rel: string, source: string, aliases: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const match of source.matchAll(/\.onConflictDoUpdate\s*\(/g)) {
    const at = match.index ?? 0;
    const insertArg = insertArgOnUpsertChain(source, at);
    if (insertArg === null) {
      throw new Error(
        `${repoPath(rel)}:${lineAt(source, at)}: onConflictDoUpdate not chained to .insert(...)`,
      );
    }
    if (!insertArgIsFlagConfigs(insertArg, aliases)) continue;
    const arg = balancedBraces(source, nextObjectStart(source, at + match[0].length));
    const setKey = arg.search(/\bset\s*:/);
    if (setKey < 0) {
      throw new Error(`${repoPath(rel)}:${lineAt(source, at)}: onConflictDoUpdate with no set:`);
    }
    const afterSet = setKey + (arg.slice(setKey).match(/^\bset\s*:/)?.[0].length ?? 0);
    const setSource = balancedBraces(arg, nextObjectStart(arg, afterSet));
    sites.push({ file: rel, line: lineAt(source, at), kind: "drizzle.upsert", setSource });
  }
  return sites;
}

/**
 * Raw SQL UPDATEs of the table, including quoted identifiers and
 * `UPDATE flag_configs AS fc SET …`. Scored against the enclosing template
 * literal only.
 */
function sqlUpdateSites(rel: string, source: string): UpdateSite[] {
  const sites: UpdateSite[] = [];
  const pattern = /UPDATE\s+(?:"flag_configs"|flag_configs)\s+(?:AS\s+\w+\s+)?SET\b/gi;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    const template = enclosingTemplateLiteral(source, at);
    if (!template) {
      throw new Error(
        `${repoPath(rel)}:${lineAt(source, at)}: flag_configs UPDATE outside a template literal`,
      );
    }
    sites.push({ file: rel, line: lineAt(source, at), kind: "sql.UPDATE", setSource: template });
  }
  return sites;
}

function updateSitesIn(rel: string): UpdateSite[] {
  const source = read(rel);
  const aliases = tableAliases(source);
  const facades = scopedFacades(source, aliases);
  return [
    ...drizzleUpdateSites(rel, source, aliases),
    ...scopedTableUpdateSites(rel, source, facades),
    ...upsertSites(rel, source, aliases),
    ...sqlUpdateSites(rel, source),
  ];
}

describe("every flag_configs UPDATE bumps version", () => {
  it("states a scan root that actually contains the production writers", () => {
    expect(SCAN_ROOT).toBe("packages/db/src/repo");
    expect(relative(REPO_ROOT, SRC).replaceAll("\\", "/")).toBe(SCAN_ROOT);

    const files = sourceFiles(SRC);
    for (const mod of WRITER_MODULES) {
      expect(files, `${repoPath(mod)} missing from ${SCAN_ROOT}`).toContain(mod);
      expect(updateSitesIn(mod), `${repoPath(mod)} no longer UPDATEs flag_configs`).not.toEqual([]);
    }
  });

  it("leaves no module naming flagConfigs unaccounted for", () => {
    const touching = sourceFiles(SRC).filter((rel) => namesFlagConfigs(read(rel)));
    expect(touching.sort()).toEqual(Object.keys(FLAG_CONFIGS_MODULES).sort());
  });

  it("leaves no UPDATE or UPSERT site whose version bump does not win", () => {
    const sites = sourceFiles(SRC).flatMap(updateSitesIn);

    expect(sites.length).toBeGreaterThan(0);

    const writerFiles = new Set(sites.map((s) => s.file));
    for (const file of writerFiles) {
      expect(
        FLAG_CONFIGS_MODULES[file],
        `${repoPath(file)} UPDATEs flag_configs but is not classified as writer`,
      ).toBe("writer");
    }

    const violators = sites.filter((site) => !bumpWins(site));
    expect(
      violators.map((s) => `${repoPath(s.file)}:${s.line} (${s.kind})`),
      "flag_configs UPDATE/UPSERT without a winning version bump",
    ).toEqual([]);
  });

  it("accepts any identifier.version + 1 and rejects spread-source / pinnable RHS", () => {
    expect(isBumpExpr("existing.version + 1")).toBe(true);
    expect(isBumpExpr("current.version + 1")).toBe(true);
    expect(isBumpExpr("patch.version + 1", new Set(["patch"]))).toBe(false);
    expect(isBumpExpr("patch.version ?? current.version + 1")).toBe(false);
  });
});
