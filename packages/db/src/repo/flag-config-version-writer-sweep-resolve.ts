/**
 * TypeChecker-backed resolution of flag_configs UPDATE call sites (SPL-350).
 * Imported only by the writer-sweep test — excluded from the package build.
 */

import { relative, resolve } from "node:path";
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
const SRC_ROOT = resolve(PKG_ROOT, "src");
const SCHEMA_FLAGS = resolve(SRC_ROOT, "schema/flags.ts");
const FLAGS_REPO = resolve(SRC_ROOT, "repo/flags.ts");

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

function canonicalFacadeType(checker: ts.TypeChecker, program: ts.Program): ts.Type {
  const flagsSource = program.getSourceFile(FLAGS_REPO);
  if (!flagsSource) fail(`missing ${FLAGS_REPO}`);
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "flagConfigsTable" &&
      node.initializer
    ) {
      found = checker.getTypeAtLocation(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(flagsSource);
  if (!found) fail("canonical flagConfigsTable not found in repo/flags.ts");
  return unwrapType(checker, found);
}

function collectSites(anchor: FacadeAnchor, source: ts.SourceFile): ResolvedUpdateSite[] {
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

/**
 * Every `flag_configs` UPDATE call in the production `packages/db` program,
 * resolved by TypeChecker symbol/type identity (not source-text spellings).
 */
export function resolveFlagConfigUpdateSites(): ResolvedUpdateSite[] {
  const program = createProductionProgram();
  assertProgramReliable(program);
  const checker = program.getTypeChecker();
  const schemaSource = program.getSourceFile(SCHEMA_FLAGS);
  if (!schemaSource) fail(`missing ${SCHEMA_FLAGS}`);
  const anchor: FacadeAnchor = {
    checker,
    facadeType: canonicalFacadeType(checker, program),
    flagConfigs: exportSymbol(checker, schemaSource, "flagConfigs"),
    relFile,
  };

  const sites: ResolvedUpdateSite[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    if (!source.fileName.startsWith(SRC_ROOT)) continue;
    if (/\.test\.ts$|\.spec\.ts$/.test(source.fileName)) continue;
    sites.push(...collectSites(anchor, source));
  }

  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
