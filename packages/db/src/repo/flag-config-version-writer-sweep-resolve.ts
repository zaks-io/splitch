/**
 * TypeChecker-backed resolution of flag_configs UPDATE call sites (SPL-350).
 * Imported only by the writer-sweep test — excluded from the package build.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  type FacadeAnchor,
  type ResolvedUpdateSite,
  tryDrizzleSite,
  tryScopedSite,
  unwrapType,
} from "./flag-config-version-writer-sweep-resolve-calls";

export type { ResolvedUpdateSite } from "./flag-config-version-writer-sweep-resolve-calls";

const PKG_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPO_ROOT = resolve(PKG_ROOT, "../..");
/** Absolute path of the production sources the checker program walks. */
export const FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT = resolve(PKG_ROOT, "src");
const SRC_ROOT = FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT;
const SCHEMA_FLAGS = resolve(SRC_ROOT, "schema/flags.ts");
const FLAGS_REPO = resolve(SRC_ROOT, "repo/flags.ts");
const SCOPED_TABLE = resolve(SRC_ROOT, "repo/scoped-table.ts");

/**
 * Paths under `src/` excluded from the production tsconfig (and therefore from
 * the sweep program). Kept in sync with `packages/db/tsconfig.json` `exclude`
 * entries that are not already covered by the `.test.ts` / `.spec.ts` filter.
 */
const PRODUCTION_TSCONFIG_EXCLUDED_RELS = new Set([
  "repo/test-d1.ts",
  "repo/test-d1-pool.ts",
  "repo/test-d1-pool-setup.ts",
  "repo/test-seed.ts",
]);

function fail(message: string): never {
  throw new Error(`flag_configs version sweep: ${message}`);
}

function relFile(source: ts.SourceFile): string {
  return relative(SRC_ROOT, source.fileName).replaceAll("\\", "/");
}

function createProductionProgram(): ts.Program {
  const configPath = resolve(PKG_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    fail(`tsconfig read failed: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    PKG_ROOT,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    fail(
      `tsconfig parse failed:\n${parsed.errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("\n")}`,
    );
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function assertProgramReliable(program: ts.Program): void {
  const diags = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length === 0) return;
  fail(
    `program has ${diags.length} error diagnostic(s); resolution would be unreliable:\n${diags
      .slice(0, 8)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("\n")}`,
  );
}

function exportSymbol(checker: ts.TypeChecker, source: ts.SourceFile, name: string): ts.Symbol {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) fail(`no module symbol for ${source.fileName}`);
  const found = checker.getExportsOfModule(moduleSymbol).find((sym) => sym.getName() === name);
  if (!found) fail(`export \`${name}\` not found in ${source.fileName}`);
  return found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function calleeSymbol(checker: ts.TypeChecker, expr: ts.Expression): ts.Symbol | undefined {
  const target = ts.isIdentifier(expr)
    ? expr
    : ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)
      ? expr.name
      : expr;
  const sym = checker.getSymbolAtLocation(target);
  return sym ? resolveAlias(checker, sym) : undefined;
}

/** True when `call` is `scopedTable(…, flagConfigs)` by symbol identity. */
function isScopedFlagConfigsCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  scopedTableSym: ts.Symbol,
  flagConfigs: ts.Symbol,
): boolean {
  if (call.arguments.length < 2) return false;
  if (calleeSymbol(checker, call.expression) !== scopedTableSym) return false;
  const tableArg = call.arguments[1];
  if (!tableArg) return false;
  const tableSym = checker.getSymbolAtLocation(tableArg);
  return !!tableSym && resolveAlias(checker, tableSym) === flagConfigs;
}

/**
 * Canonical facade type: return type of `scopedTable(db, flagConfigs)` in
 * `repo/flags.ts`, located by call-target and table-argument symbol identity
 * (not by the local binding name).
 */
function canonicalFacadeType(
  checker: ts.TypeChecker,
  program: ts.Program,
  flagConfigs: ts.Symbol,
): ts.Type {
  const flagsSource = program.getSourceFile(FLAGS_REPO);
  if (!flagsSource) fail(`missing ${FLAGS_REPO}`);
  const scopedSource = program.getSourceFile(SCOPED_TABLE);
  if (!scopedSource) fail(`missing ${SCOPED_TABLE}`);
  const scopedTableSym = exportSymbol(checker, scopedSource, "scopedTable");

  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isScopedFlagConfigsCall(checker, node, scopedTableSym, flagConfigs)
    ) {
      found = checker.getTypeAtLocation(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(flagsSource);
  if (!found) {
    fail("canonical scopedTable(db, flagConfigs) call not found in repo/flags.ts");
  }
  return unwrapType(checker, found);
}

function facadeUpdateMethodType(checker: ts.TypeChecker, facadeType: ts.Type): ts.Type {
  const update = facadeType.getProperty("update");
  if (!update) fail("canonical facade type has no `update` property");
  return unwrapType(checker, checker.getApparentType(checker.getTypeOfSymbol(update)));
}

/**
 * Path-based twin of the SourceFile filter used when walking the program.
 * Sweep helpers (`flag-config-version-writer-sweep*`) are build-excluded and
 * are not production writers.
 */
function isSweepProductionRelPath(rel: string): boolean {
  const normalized = rel.replaceAll("\\", "/");
  if (!normalized.endsWith(".ts") || normalized.endsWith(".d.ts")) return false;
  if (/\.test\.ts$|\.spec\.ts$/.test(normalized)) return false;
  if (PRODUCTION_TSCONFIG_EXCLUDED_RELS.has(normalized)) return false;
  if (/(^|\/)flag-config-version-writer-sweep[^/]*\.ts$/.test(normalized)) return false;
  return true;
}

function isProductionSource(source: ts.SourceFile): boolean {
  if (source.isDeclarationFile) return false;
  if (!source.fileName.startsWith(SRC_ROOT)) return false;
  return isSweepProductionRelPath(relFile(source));
}

/**
 * Every production `.ts` under the scan root the filesystem can see, filtered
 * by the same rules as the resolver walk. Independent of which SourceFiles the
 * program loop actually visited — so a narrowed walk fails `toEqual`.
 */
export function listExpectedScannedFiles(): string[] {
  const out: string[] = [];
  const walk = (absDir: string): void => {
    for (const name of readdirSync(absDir)) {
      const abs = join(absDir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = relative(SRC_ROOT, abs).replaceAll("\\", "/");
      if (isSweepProductionRelPath(rel)) out.push(rel);
    }
  };
  walk(SRC_ROOT);
  return out.sort((a, b) => a.localeCompare(b));
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/**
 * Raw `sql\`UPDATE … flag_configs\`` (or `${flagConfigs}`) inside the scan root
 * is invisible to the type-driven drizzle/scopedTable selectors. Fail loud —
 * same posture as non-literal `.set(values)` — rather than silently green.
 */
function assertNoRawFlagConfigsSqlUpdate(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const text = node.getText(source);
      const touchesFlagConfigs = /\bflag_configs\b/.test(text) || /\bflagConfigs\b/.test(text);
      if (/\bUPDATE\b/i.test(text) && touchesFlagConfigs) {
        const where = `${relFile(source)}:${lineOf(source, node)}`;
        fail(
          `${where}: raw sql UPDATE of flag_configs cannot be scored by the ` +
            `type-driven sweep — use db.update(flagConfigs) or scopedTable.update ` +
            `so the version bump is enforced`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function collectSites(anchor: FacadeAnchor, source: ts.SourceFile): ResolvedUpdateSite[] {
  assertNoRawFlagConfigsSqlUpdate(source);
  const sites: ResolvedUpdateSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const scoped = tryScopedSite(anchor, node, source);
      if (scoped) sites.push(scoped);
      else {
        const drizzle = tryDrizzleSite(anchor, node, source);
        if (drizzle) sites.push(drizzle);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

export type FlagConfigUpdateResolution = {
  /** Repo-relative scan root the resolver walks (`packages/db/src`). */
  scanRoot: string;
  /** Production source files under `scanRoot` that were walked for CallExpressions. */
  scannedFiles: string[];
  sites: ResolvedUpdateSite[];
};

/**
 * Every `flag_configs` UPDATE call in the production `packages/db` program,
 * resolved by TypeChecker symbol/type identity (not source-text spellings).
 */
export function resolveFlagConfigUpdates(): FlagConfigUpdateResolution {
  const program = createProductionProgram();
  assertProgramReliable(program);
  const checker = program.getTypeChecker();
  const schemaSource = program.getSourceFile(SCHEMA_FLAGS);
  if (!schemaSource) fail(`missing ${SCHEMA_FLAGS}`);
  const flagConfigs = exportSymbol(checker, schemaSource, "flagConfigs");
  const facadeType = canonicalFacadeType(checker, program, flagConfigs);
  const anchor: FacadeAnchor = {
    checker,
    facadeType,
    updateMethodType: facadeUpdateMethodType(checker, facadeType),
    flagConfigs,
    relFile,
  };

  const scannedFiles: string[] = [];
  const sites: ResolvedUpdateSite[] = [];
  for (const source of program.getSourceFiles()) {
    if (!isProductionSource(source)) continue;
    scannedFiles.push(relFile(source));
    sites.push(...collectSites(anchor, source));
  }

  scannedFiles.sort((a, b) => a.localeCompare(b));
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    scanRoot: relative(REPO_ROOT, SRC_ROOT).replaceAll("\\", "/"),
    scannedFiles,
    sites,
  };
}
