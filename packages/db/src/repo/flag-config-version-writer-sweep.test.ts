import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveFlagConfigBindings } from "./flag-config-version-writer-sweep-bindings";
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
  secondArgObject,
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
 * Scan root (asserted below): `packages/db/src`. The narrowed
 * `repo.flags.flagConfigs` export (findMany/findOne/insert only) makes a facade
 * bypass a compile error in typechecked source and a TypeError everywhere else —
 * including `apps/control-plane-api/test/` and the three `@splitch/db` importers
 * in `apps/cli` that sit outside every tsconfig (`quickstart-local-harness.ts`,
 * `dark-launch-experiment.ts`, `dark-launch-http.ts`), where the runtime
 * TypeError is what covers them. This sweep catches raw-`db` writers inside
 * `packages/db/src`. Raw `D1Database.prepare` UPDATEs of `flag_configs` are
 * outside both and are not guarded.
 *
 * Including those harnesses in a tsconfig would typecheck them and their
 * transitive helpers under CI, lengthening typecheck and likely surfacing latent
 * harness-only type errors that are currently invisible; left alone on purpose.
 */

/** Repo-relative path of the directory this file sweeps. Stated so it is checked. */
const SCAN_ROOT = "packages/db/src";

const SRC = fileURLToPath(new URL("../", import.meta.url));
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
    "wires scopedTable and DELETE cascade; UPDATEs go through makeFlagConfigOps. Exported flagConfigs is findMany/findOne/insert only",
  "repo/flag-config-ops.ts": "writer",
  "repo/flag-variant-approval.ts": "writer",
  "repo/flag-config-version-writer-sweep-lib.ts": "structural sweep helpers; no production UPDATE",
  "repo/flag-config-version-writer-sweep-bindings.ts":
    "structural sweep alias resolver; no production UPDATE",
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

/** `const { update } = facade; update(scope, values)` — same set-object shape. */
function directUpdateSites(rel: string, source: string, names: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const name of names) {
    // Bare call only — do not match `db.update(` / `foo.update(`.
    for (const match of source.matchAll(new RegExp(`(?<![.\\w])${name}\\s*\\(`, "g"))) {
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
 * Must be chained to `.insert(…)`; a split-statement upsert of flagConfigs fails
 * loud rather than being silently skipped. Files that never name a flagConfigs
 * alias are skipped entirely so unrelated upserts cannot false-red.
 */
function upsertSites(rel: string, source: string, aliases: Set<string>): UpdateSite[] {
  const sites: UpdateSite[] = [];
  if (aliases.size === 0) return sites;
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
  const { tables, facades, directUpdates } = resolveFlagConfigBindings(source);
  return [
    ...drizzleUpdateSites(rel, source, tables),
    ...scopedTableUpdateSites(rel, source, facades),
    ...directUpdateSites(rel, source, directUpdates),
    ...upsertSites(rel, source, tables),
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

  it("accepts any identifier.version + 1 and rejects spread-source / pinnable RHS", () => {
    expect(isBumpExpr("existing.version + 1")).toBe(true);
    expect(isBumpExpr("current.version + 1")).toBe(true);
    expect(isBumpExpr("patch.version + 1", new Set(["patch"]))).toBe(false);
    expect(isBumpExpr("patch.version ?? current.version + 1")).toBe(false);
  });

  it("chainedSetAt skips comments between .update and .set", () => {
    const source = ".update(flagConfigs)\n  // keep going\n  .set({";
    const after = source.indexOf(")") + 1;
    expect(chainedSetAt(source, after)).toBe(source.indexOf(".set("));
  });

  it("insertArgOnUpsertChain returns null for a split-statement upsert", () => {
    const source =
      "const q = db.insert(flagConfigs).values(row);\nq.onConflictDoUpdate({ set: {} });";
    const at = source.indexOf(".onConflictDoUpdate");
    expect(insertArgOnUpsertChain(source, at)).toBeNull();
  });

  it("drizzleUpdatePattern matches namespace-qualified table refs", () => {
    const source = "db.update(schema.flagConfigs).set({ enabled: true });";
    expect([...source.matchAll(drizzleUpdatePattern("flagConfigs"))]).toHaveLength(1);
  });

  it("resolveFlagConfigBindings follows aliases to a fixed point", () => {
    const source = [
      "const flagConfigsTable = scopedTable(db, flagConfigs);",
      "const tbl = flagConfigsTable;",
      "const hop = tbl;",
      "const { update } = hop;",
      "const raw = schema.flagConfigs;",
      "const raw2 = raw;",
    ].join("\n");
    const bindings = resolveFlagConfigBindings(source);
    expect(bindings.facades.has("flagConfigsTable")).toBe(true);
    expect(bindings.facades.has("tbl")).toBe(true);
    expect(bindings.facades.has("hop")).toBe(true);
    expect(bindings.directUpdates.has("update")).toBe(true);
    expect(bindings.tables.has("raw")).toBe(true);
    expect(bindings.tables.has("raw2")).toBe(true);
  });
});
