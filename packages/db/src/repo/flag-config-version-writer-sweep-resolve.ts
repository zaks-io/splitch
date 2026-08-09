/**
 * TypeChecker-backed resolution of flag_configs UPDATE call sites (SPL-350).
 * Imported only by the writer-sweep test — excluded from the package build.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  type FacadeAnchor,
  type ResolvedUpdateSite,
  tryDrizzleSite,
  tryScopedSite,
  unwrapType,
} from "./flag-config-version-writer-sweep-resolve-calls";
import { assertNoRawFlagConfigsSqlUpdate } from "./flag-config-version-writer-sweep-resolve-sql";

export type { ResolvedUpdateSite } from "./flag-config-version-writer-sweep-resolve-calls";

const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = resolve(PKG_ROOT, "../..");
/** Absolute path of the production sources the checker program walks. */
export const FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT = resolve(PKG_ROOT, "src");
const SRC_ROOT = FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT;
const SCHEMA_FLAGS = resolve(SRC_ROOT, "schema/flags.ts");
const FLAGS_REPO = resolve(SRC_ROOT, "repo/flags.ts");
const SCOPED_TABLE = resolve(SRC_ROOT, "repo/scoped-table.ts");

function fail(message: string): never {
  throw new Error(`flag_configs version sweep: ${message}`);
}

function relPath(absPath: string): string {
  return relative(SRC_ROOT, absPath).replaceAll("\\", "/");
}

function relFile(source: ts.SourceFile): string {
  return relPath(source.fileName);
}

function parseProductionTsconfig(): ts.ParsedCommandLine {
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
  return parsed;
}

function isUnderSrcRoot(fileName: string): boolean {
  const rel = relative(SRC_ROOT, resolve(fileName));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function productionScanFileNames(parsed: ts.ParsedCommandLine): string[] {
  return parsed.fileNames
    .filter((fileName) => isUnderSrcRoot(fileName))
    .filter((fileName) => !fileName.endsWith(".d.ts"))
    .sort((a, b) => relPath(a).localeCompare(relPath(b)));
}

function createProductionProgram(parsed: ts.ParsedCommandLine): ts.Program {
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
 * Production source files come from TypeScript's parsed tsconfig fileNames, not
 * a filesystem walk. This keeps the resolver's inventory identical to the build
 * graph and makes tsconfig include/exclude changes fail visibly in the test.
 */
export function listExpectedScannedFiles(): string[] {
  return productionScanFileNames(parseProductionTsconfig()).map(relPath);
}

function collectUpdateSites(anchor: FacadeAnchor, source: ts.SourceFile): ResolvedUpdateSite[] {
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

function countUpdateCandidates(anchor: FacadeAnchor, source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const scoped = tryScopedSite(anchor, node, source);
      if (scoped) count += 1;
      else if (tryDrizzleSite(anchor, node, source)) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

export type FlagConfigUpdateResolution = {
  /** Repo-relative scan root the resolver walks (`packages/db/src`). */
  scanRoot: string;
  /** Production source files under `scanRoot` that were walked for CallExpressions. */
  scannedFiles: string[];
  /** Independent count of flag_configs UPDATE candidates before site collection. */
  candidateCount: number;
  sites: ResolvedUpdateSite[];
};

/**
 * Every `flag_configs` UPDATE call in the production `packages/db` program,
 * resolved by TypeChecker symbol/type identity (not source-text spellings).
 */
export function resolveFlagConfigUpdates(): FlagConfigUpdateResolution {
  const parsed = parseProductionTsconfig();
  const scanFileNames = productionScanFileNames(parsed);
  const program = createProductionProgram(parsed);
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
  let candidateCount = 0;
  for (const fileName of scanFileNames) {
    const source = program.getSourceFile(fileName);
    if (!source) fail(`tsconfig fileName missing from program: ${fileName}`);
    assertNoRawFlagConfigsSqlUpdate(anchor, source);
    scannedFiles.push(relFile(source));
    candidateCount += countUpdateCandidates(anchor, source);
    sites.push(...collectUpdateSites(anchor, source));
  }

  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    scanRoot: relative(REPO_ROOT, SRC_ROOT).replaceAll("\\", "/"),
    scannedFiles,
    candidateCount,
    sites,
  };
}
