import {
  type ClassLikeDeclaration,
  type Expression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isExportDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type PropertyName,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { locationOf, unwrap } from "./hosted-worker-wrap-ast.js";

export interface ExportedFetchClass {
  readonly exportName: string;
  readonly className: string;
  readonly declaration: ClassLikeDeclaration;
  readonly workerEntrypoint: boolean;
}

export interface UnsupportedExportedFetchClass {
  readonly exportName: string;
  readonly location: string;
}

export function exportedFetchClasses(file: SourceFile): ExportedFetchClass[] {
  const classes = moduleClasses(file);
  const exports = exportedNames(file, classes);
  const found: ExportedFetchClass[] = [];
  for (const [className, exportNames] of exports) {
    const declaration = classes.get(className);
    if (!declaration) continue;
    const workerEntrypoint = extendsOfficialWorkerEntrypoint(file, declaration);
    if (!workerEntrypoint && !hasFetchMethod(declaration)) continue;
    for (const exportName of exportNames) {
      found.push({ exportName, className, declaration, workerEntrypoint });
    }
  }
  return found;
}

export function findExportedClass(
  file: SourceFile,
  exportOrClassName: string,
): ClassLikeDeclaration | undefined {
  const exported = exportedFetchClasses(file).find(
    (entry) => entry.exportName === exportOrClassName || entry.className === exportOrClassName,
  );
  if (exported) return exported.declaration;
  return moduleClasses(file).get(exportOrClassName);
}

export function unsupportedExportedFetchClasses(file: SourceFile): UnsupportedExportedFetchClass[] {
  return exportedFetchClasses(file)
    .filter((entry) => !entry.workerEntrypoint)
    .map((entry) => ({
      exportName: entry.exportName,
      location: locationOf(file, entry.declaration),
    }));
}

function moduleClasses(file: SourceFile): Map<string, ClassLikeDeclaration> {
  const classes = new Map<string, ClassLikeDeclaration>();
  for (const statement of file.statements) {
    if (isClassDeclaration(statement) && statement.name) {
      classes.set(statement.name.text, statement);
    }
    for (const [name, declaration] of variableClassExpressions(statement)) {
      classes.set(name, declaration);
    }
  }
  return classes;
}

function variableClassExpressions(statement: Node): Array<readonly [string, ClassLikeDeclaration]> {
  if (!isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => {
    if (!isIdentifier(declaration.name) || !declaration.initializer) return [];
    const initializer = unwrap(declaration.initializer);
    return isClassExpression(initializer) ? [[declaration.name.text, initializer] as const] : [];
  });
}

function exportedNames(
  file: SourceFile,
  classes: ReadonlyMap<string, ClassLikeDeclaration>,
): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  const add = (className: string, exportName: string): void => {
    if (!classes.has(className)) return;
    const current = names.get(className) ?? new Set<string>();
    current.add(exportName);
    names.set(className, current);
  };
  for (const statement of file.statements) {
    for (const direct of directlyExportedClassNames(statement, classes)) add(direct, direct);
    for (const [className, exportName] of namedClassExports(statement)) add(className, exportName);
  }
  return names;
}

function directlyExportedClassNames(
  statement: Node,
  classes: ReadonlyMap<string, ClassLikeDeclaration>,
): string[] {
  if (!isClassDeclaration(statement) && !isVariableStatement(statement)) return [];
  const exported = statement.modifiers?.some(
    (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
  );
  if (!exported) return [];
  if (isClassDeclaration(statement)) return statement.name ? [statement.name.text] : [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    isIdentifier(declaration.name) && classes.has(declaration.name.text)
      ? [declaration.name.text]
      : [],
  );
}

function namedClassExports(statement: Node): Array<readonly [string, string]> {
  if (
    !isExportDeclaration(statement) ||
    statement.isTypeOnly ||
    statement.moduleSpecifier ||
    !statement.exportClause ||
    !isNamedExports(statement.exportClause)
  ) {
    return [];
  }
  return statement.exportClause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => [(element.propertyName ?? element.name).text, element.name.text] as const);
}

function hasFetchMethod(cls: ClassLikeDeclaration): boolean {
  return cls.members.some(
    (member) =>
      (isMethodDeclaration(member) ||
        isPropertyDeclaration(member) ||
        isGetAccessorDeclaration(member) ||
        isSetAccessorDeclaration(member)) &&
      isFetchPropertyName(member.name),
  );
}

export function isFetchPropertyName(name: PropertyName): boolean {
  if (isIdentifier(name) || isStringLiteral(name)) return name.text === "fetch";
  return (
    isComputedPropertyName(name) &&
    isStringLiteral(name.expression) &&
    name.expression.text === "fetch"
  );
}

function extendsOfficialWorkerEntrypoint(file: SourceFile, cls: ClassLikeDeclaration): boolean {
  return (cls.heritageClauses ?? []).some(
    (clause) =>
      clause.token === SyntaxKind.ExtendsKeyword &&
      clause.types.some((type) => denotesOfficialWorkerEntrypoint(file, type.expression)),
  );
}

function denotesOfficialWorkerEntrypoint(file: SourceFile, expression: Expression): boolean {
  const value = unwrap(expression);
  if (isPropertyAccessExpression(value)) {
    if (value.name.text !== "WorkerEntrypoint") return false;
    const target = unwrap(value.expression);
    return isIdentifier(target) && isOfficialWorkersNamespace(file, target);
  }
  if (!isIdentifier(value)) return false;
  const binding = moduleBinding(file, value.text);
  if (!binding) return false;
  if (isImportDeclaration(binding)) return isOfficialNamedImport(binding, value.text);
  return false;
}

function moduleBinding(file: SourceFile, name: string): Node | undefined {
  for (const statement of file.statements) {
    if (localDeclarationBinds(statement, name) || importBinds(statement, name)) return statement;
  }
  return undefined;
}

function localDeclarationBinds(statement: Node, name: string): boolean {
  if (isClassDeclaration(statement)) return statement.name?.text === name;
  if (!isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.some(
    (declaration) => isIdentifier(declaration.name) && declaration.name.text === name,
  );
}

function importBinds(statement: Node, name: string): boolean {
  if (!isImportDeclaration(statement)) return false;
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return false;
  if (isNamespaceImport(bindings)) return bindings.name.text === name;
  return (
    isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === name)
  );
}

function isOfficialNamedImport(statement: Node, localName: string): boolean {
  if (!isImportDeclaration(statement) || !isCloudflareWorkersImport(statement)) return false;
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !isNamedImports(bindings)) return false;
  return bindings.elements.some(
    (element) =>
      element.name.text === localName &&
      (element.propertyName ?? element.name).text === "WorkerEntrypoint",
  );
}

function isOfficialWorkersNamespace(file: SourceFile, identifier: Node): boolean {
  if (!isIdentifier(identifier)) return false;
  const binding = moduleBinding(file, identifier.text);
  if (!binding || !isImportDeclaration(binding) || !isCloudflareWorkersImport(binding))
    return false;
  const bindings = binding.importClause?.namedBindings;
  return Boolean(bindings && isNamespaceImport(bindings) && bindings.name.text === identifier.text);
}

function isCloudflareWorkersImport(statement: Node): boolean {
  return (
    isImportDeclaration(statement) &&
    isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "cloudflare:workers"
  );
}
