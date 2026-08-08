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
 * Scan root (asserted below, not assumed): `packages/db/src`. Closure matches
 * `variant-rename-writer-sweep.test.ts`: every module under this root that names
 * `flagConfigs` / `flag_configs` must be classified. Writers are then checked for
 * every UPDATE/UPSERT shape that can reach the table — not a fixed list of call
 * spellings — and the bump must be the property that WINS after spreads.
 *
 * Consumers of the exported `repo.flags.flagConfigs` facade live outside this
 * root. A raw `.update` there is swept by
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
};

const WRITER_MODULES = Object.entries(FLAG_CONFIGS_MODULES)
  .filter(([, kind]) => kind === "writer")
  .map(([rel]) => rel);

/** A version value that advances the counter (JS property or SQL assignment RHS). */
const VERSION_BUMP_EXPR = /(?:sql`[^`]*\+\s*1[^`]*`|[^\n,;]*\+\s*1)/;

type UpdateSite = {
  file: string;
  line: number;
  kind: "drizzle.update" | "scopedTable.update" | "sql.UPDATE" | "drizzle.upsert";
  setSource: string;
};

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

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function namesFlagConfigs(source: string): boolean {
  return /\bflagConfigs\b|\bflag_configs\b/.test(source);
}

/** Balanced `{ … }` starting at `open`, which must point at `{`. */
function balancedBraces(source: string, open: number): string {
  if (source[open] !== "{") throw new Error(`expected '{' at ${open}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i] ?? "";
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
 * Index of the Nth top-level comma inside a `(…)` call (N=1 → first comma), or
 * -1 if the call ends first.
 */
function topLevelComma(source: string, callOpenParen: number, nth: number): number {
  let depth = 0;
  let seen = 0;
  for (let i = callOpenParen; i < source.length; i++) {
    depth += nestingDelta(source[i] ?? "");
    if ((source[i] ?? "") === "," && depth === 1 && ++seen === nth) return i;
    if (depth === 0 && (source[i] ?? "") === ")") return -1;
  }
  return -1;
}

/** Second argument object of `name.update(scope, values, …)`. */
function secondArgObject(source: string, callOpenParen: number): string {
  const comma = topLevelComma(source, callOpenParen, 1);
  if (comma < 0) throw new Error("update call ended before second arg");
  return balancedBraces(source, nextObjectStart(source, comma + 1));
}

/**
 * Bindings that refer to the `flagConfigs` table object, including
 * `import { flagConfigs as cfg }` aliases and `const x = flagConfigs`.
 */
function tableAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  if (/\bflagConfigs\b/.test(source)) aliases.add("flagConfigs");
  for (const match of source.matchAll(/\bflagConfigs\s+as\s+(\w+)\b/g)) {
    if (match[1]) aliases.add(match[1]);
  }
  for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*flagConfigs\b/g)) {
    if (match[1]) aliases.add(match[1]);
  }
  return aliases;
}

/**
 * Facade bindings whose table is `flagConfigs`: `scopedTable(db, alias)` locals
 * and any parameter typed `ScopedTable<typeof alias>`, whatever the parameter
 * is named — the type is the closure, not a hardcoded identifier.
 */
function scopedFacades(source: string, aliases: Set<string>): Set<string> {
  const facades = new Set<string>();
  for (const alias of aliases) {
    collectFacadeNames(source, alias, facades);
  }
  return facades;
}

function collectFacadeNames(source: string, alias: string, facades: Set<string>): void {
  const local = new RegExp(
    `(?:const|let)\\s+(\\w+)\\s*=\\s*scopedTable\\(\\s*\\w+\\s*,\\s*${alias}\\s*\\)`,
    "g",
  );
  for (const match of source.matchAll(local)) {
    if (match[1]) facades.add(match[1]);
  }
  const param = new RegExp(`(\\w+)\\s*:\\s*ScopedTable\\s*<\\s*typeof\\s+${alias}\\s*>`, "g");
  for (const match of source.matchAll(param)) {
    if (match[1]) facades.add(match[1]);
  }
}

function drizzleUpdateSites(rel: string, source: string, aliases: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const alias of aliases) {
    for (const match of source.matchAll(new RegExp(`\\.update\\(\\s*${alias}\\s*\\)`, "g"))) {
      const at = match.index ?? 0;
      const setAt = source.indexOf(".set(", at + match[0].length);
      if (setAt < 0) {
        throw new Error(`${repoPath(rel)}:${lineAt(source, at)}: .update(${alias}) with no .set(`);
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
 * Look back from each upsert for an insert of a flagConfigs alias.
 */
function upsertSites(rel: string, source: string, aliases: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const match of source.matchAll(/\.onConflictDoUpdate\s*\(/g)) {
    const at = match.index ?? 0;
    const before = source.slice(Math.max(0, at - 400), at);
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
 * `UPDATE flag_configs AS fc SET …`.
 */
function sqlUpdateSites(rel: string, source: string): UpdateSite[] {
  const sites: UpdateSite[] = [];
  const pattern = /UPDATE\s+(?:"flag_configs"|flag_configs)\s+(?:AS\s+\w+\s+)?SET\b/gi;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    const setSource = source.slice(at, at + 400);
    sites.push({ file: rel, line: lineAt(source, at), kind: "sql.UPDATE", setSource });
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

/**
 * Top-level comma-separated segments of an object literal body, respecting
 * nesting so nested objects/calls do not split early.
 */
function topLevelSegments(body: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  let inTemplate = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate) continue;
    depth += nestingDelta(ch);
    if (ch === "," && depth === 0) {
      segments.push(body.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(body.slice(start));
  return segments;
}

function isBumpExpr(expr: string): boolean {
  return VERSION_BUMP_EXPR.test(expr.trim());
}

function objectHasVersionKey(objectSource: string): boolean {
  if (!objectSource.startsWith("{") || !objectSource.endsWith("}")) return false;
  return topLevelSegments(objectSource.slice(1, -1)).some((segment) =>
    /^\s*version\s*:/.test(segment),
  );
}

/**
 * Whether a spread RHS can introduce `version`. Bare identifiers (`...patch`)
 * can; object literals / ternaries of object literals that never name `version`
 * cannot — that is the `...(options.updatedAt ? { updatedAt } : {})` shape on
 * the rename writer, which must stay green without changing writer behavior.
 */
function spreadCanSetVersion(expr: string): boolean {
  const trimmed = expr.trim();
  if (objectHasVersionKey(trimmed)) return true;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return false;

  const question = trimmed.indexOf("?");
  if (question < 0) return true;
  let depth = 0;
  for (let i = question + 1; i < trimmed.length; i++) {
    const ch = trimmed[i] ?? "";
    depth += nestingDelta(ch);
    if (ch === ":" && depth === 0) {
      const left = trimmed.slice(question + 1, i).trim();
      const right = trimmed.slice(i + 1).trim();
      return objectHasVersionKey(left) || objectHasVersionKey(right);
    }
  }
  return true;
}

type EffectiveVersion = "bump" | "other" | "unknown" | null;

function applySetSegment(effective: EffectiveVersion, segment: string): EffectiveVersion {
  const trimmed = segment.trim();
  if (!trimmed) return effective;
  if (trimmed.startsWith("...")) {
    return spreadCanSetVersion(trimmed.slice(3)) ? "unknown" : effective;
  }
  const version = trimmed.match(/^version\s*:\s*([\s\S]+)$/);
  if (version?.[1] === undefined) return effective;
  return isBumpExpr(version[1]) ? "bump" : "other";
}

/**
 * The bump must be the assignment that WINS. A leading
 * `{ version: current.version + 1, ...patch }` still contains bump text but
 * lets a caller-supplied `patch.version` pin the counter and disable the CAS.
 */
function bumpWins(site: UpdateSite): boolean {
  if (site.kind === "sql.UPDATE") {
    return /\bversion\s*=\s*[^\n;]*\+\s*1/i.test(site.setSource);
  }
  if (!site.setSource.startsWith("{") || !site.setSource.endsWith("}")) return false;
  let effective: EffectiveVersion = null;
  for (const segment of topLevelSegments(site.setSource.slice(1, -1))) {
    effective = applySetSegment(effective, segment);
  }
  return effective === "bump";
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
