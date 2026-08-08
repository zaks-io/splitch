import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  balancedBraces,
  bumpWins,
  chainedSetAt,
  enclosingTemplateLiteral,
  lineAt,
  nextObjectStart,
  scopedFacades,
  secondArgObject,
  statementStart,
  tableAliases,
  type UpdateSite,
} from "./flag-config-version-writer-sweep-lib";

/**
 * Structural sweep: every UPDATE of `flag_configs` bumps `version` (SPL-350).
 *
 * `flag_configs.version` is the documented primary defense against stale-config
 * writes. The compare-and-set in `flag-config-ops.ts` only works when every
 * writer advances the counter. A new UPDATE that forgets the bump compiles,
 * passes review, and silently disables the CAS for every path that races it —
 * the same failure shape the kill-switch copy-drift guard exists to catch.
 *
 * Scan root (asserted below, not assumed): `packages/db/src`. Closure matches
 * `variant-rename-writer-sweep.test.ts`: every module under this root that names
 * `flagConfigs` / `flag_configs` must be classified. Writers are then checked for
 * every UPDATE/UPSERT shape that can reach the table — not a fixed list of call
 * spellings — and the bump must be an allowlisted derivation that WINS after
 * spreads (not merely text that contains `+ 1`).
 *
 * Consumers of the exported `repo.flags.flagConfigs` facade live outside this
 * root. A raw `.update` there is swept repo-wide by
 * `apps/control-plane-api/src/flag-config-version-caller-sweep.test.ts`.
 *
 * Out of scope: changing any writer's behavior. A genuine violator under this
 * root fails the sweep and is filed separately.
 */

/** Repo-relative path of the directory this file sweeps. Stated so it is checked. */
const SCAN_ROOT = "packages/db/src";

const SRC = fileURLToPath(new URL("../", import.meta.url));
// packages/db/src → packages/db → packages → repo root
const REPO_ROOT = resolve(SRC, "../../..");

/**
 * Every module under the scan root allowed to name `flagConfigs` / `flag_configs`,
 * with why it is not itself an UPDATE writer — or `"writer"` when it is. A new
 * module fails the sweep no matter how it writes.
 */
const FLAG_CONFIGS_MODULES: Record<string, "writer" | string> = {
  "schema/flags.ts": "table definition",
  "schema/index.ts": "schema re-export",
  "index.ts": "package export",
  "repo/scope.ts": "EnvScope docs name the table in prose only",
  "repo/flag-variant-run-freeze.ts": "freeze lookup names the column in prose only",
  "repo/test-d1-pool.ts": "test-pool cleanup table-name list; no UPDATE",
  "repo/identity-demo-reaper.ts": "DELETE cascade table-name list; no UPDATE",
  "repo/flags.ts":
    "wires scopedTable and DELETE cascade; UPDATEs go through makeFlagConfigOps. The exported facade's consumers are swept by apps/control-plane-api/src/flag-config-version-caller-sweep.test.ts",
  "repo/flag-config-ops.ts": "writer",
  "repo/flag-variant-approval.ts": "writer",
  "repo/flag-config-version-writer-sweep-lib.ts": "structural sweep helpers; no production UPDATE",
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
    for (const match of source.matchAll(new RegExp(`\\.update\\(\\s*${alias}\\s*\\)`, "g"))) {
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
 * Look back from each upsert for an insert of a flagConfigs alias on the same
 * chain (bounded, not a 400-char window into unrelated statements).
 */
function upsertSites(rel: string, source: string, aliases: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const match of source.matchAll(/\.onConflictDoUpdate\s*\(/g)) {
    const at = match.index ?? 0;
    const chainStart = statementStart(source, at);
    const before = source.slice(chainStart, at);
    const insertsFlagConfigs = [...aliases].some((alias) =>
      new RegExp(`\\.insert\\(\\s*${alias}\\s*\\)`).test(before),
    );
    if (!insertsFlagConfigs) continue;
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
 * literal only — not a 400-character window into neighboring statements.
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
    expect(SCAN_ROOT).toBe("packages/db/src");
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
});
