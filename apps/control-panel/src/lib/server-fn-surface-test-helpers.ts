import {
  canHaveModifiers,
  type Expression,
  getModifiers,
  isCallExpression,
  isExportAssignment,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { parseSourceFile, visitNodes } from "./source-file-test-helpers";

const TANSTACK_START = "@tanstack/react-start";

export function exportedPostServerFns(source: string, fileName: string): Array<string> {
  const sourceFile = parseSourceFile(source, fileName);
  const createServerFnBindings = importedCreateServerFnBindings(sourceFile);
  const localPostServerFns = localPostServerFnBindings(sourceFile, createServerFnBindings);
  return [
    ...new Set(
      sourceFile.statements.flatMap((statement) => [
        ...directExportNames(statement, localPostServerFns),
        ...namedExportNames(statement, localPostServerFns),
        ...defaultExportNames(statement, localPostServerFns, createServerFnBindings),
      ]),
    ),
  ];
}

function directExportNames(statement: Node, localPostServerFns: ReadonlySet<string>): string[] {
  if (!isVariableStatement(statement) || !isExported(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    isIdentifier(declaration.name) && localPostServerFns.has(declaration.name.text)
      ? [declaration.name.text]
      : [],
  );
}

function namedExportNames(statement: Node, localPostServerFns: ReadonlySet<string>): string[] {
  if (
    !isExportDeclaration(statement) ||
    statement.moduleSpecifier ||
    !statement.exportClause ||
    !isNamedExports(statement.exportClause)
  ) {
    return [];
  }
  return statement.exportClause.elements.flatMap((element) => {
    const localName = element.propertyName?.text ?? element.name.text;
    return localPostServerFns.has(localName) ? [element.name.text] : [];
  });
}

function defaultExportNames(
  statement: Node,
  localPostServerFns: ReadonlySet<string>,
  createServerFnBindings: ReadonlySet<string>,
): string[] {
  if (!isExportAssignment(statement) || statement.isExportEquals) return [];
  if (isIdentifier(statement.expression) && localPostServerFns.has(statement.expression.text)) {
    return ["default"];
  }
  return containsPostServerFn(statement.expression, createServerFnBindings) ? ["default"] : [];
}

function localPostServerFnBindings(
  sourceFile: SourceFile,
  createServerFnBindings: ReadonlySet<string>,
): Set<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        isIdentifier(declaration.name) &&
        declaration.initializer &&
        containsPostServerFn(declaration.initializer, createServerFnBindings)
      ) {
        bindings.add(declaration.name.text);
      }
    }
  }
  return bindings;
}

function importedCreateServerFnBindings(sourceFile: SourceFile): Set<string> {
  return new Set(
    sourceFile.statements.flatMap((statement) => {
      if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) return [];
      if (statement.moduleSpecifier.text !== TANSTACK_START) return [];
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !isNamedImports(bindings)) return [];
      return bindings.elements.flatMap((element) => {
        const importedName = element.propertyName?.text ?? element.name.text;
        return importedName === "createServerFn" ? [element.name.text] : [];
      });
    }),
  );
}

function containsPostServerFn(node: Node, bindings: ReadonlySet<string>): boolean {
  let found = false;
  visitNodes(node, (candidate) => {
    if (
      isCallExpression(candidate) &&
      isIdentifier(candidate.expression) &&
      bindings.has(candidate.expression.text) &&
      hasPostMethod(candidate.arguments[0])
    ) {
      found = true;
    }
  });
  return found;
}

function hasPostMethod(options: Expression | undefined): boolean {
  if (!options || !isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      isPropertyAssignment(property) &&
      propertyName(property.name) === "method" &&
      isStringLiteral(property.initializer) &&
      property.initializer.text === "POST",
  );
}

function propertyName(name: Node): string | null {
  if (isIdentifier(name) || isStringLiteral(name)) return name.text;
  return null;
}

function isExported(node: Node): boolean {
  if (!canHaveModifiers(node)) return false;
  return (
    getModifiers(node)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ?? false
  );
}
