import {
  type CallExpression,
  canHaveModifiers,
  getModifiers,
  isBinaryExpression,
  isCallExpression,
  isExportAssignment,
  isExportDeclaration,
  isExpressionStatement,
  isIdentifier,
  isNamedExports,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type Program,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { createServerFnResolver } from "./server-fn-symbol-test-helpers";
import { visitNodes } from "./source-file-test-helpers";

export interface ServerFnSurfaceDiscovery {
  postServerFns(filePath: string, displayName: string): string[];
}

export function createServerFnSurfaceDiscovery(program: Program): ServerFnSurfaceDiscovery {
  const resolver = createServerFnResolver(program);
  return {
    postServerFns(filePath, displayName) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile)
        throw new Error(`${displayName}: source file is absent from TypeScript program`);
      return postServerFns(sourceFile, displayName, resolver.isCreateServerFnCall);
    },
  };
}

function postServerFns(
  sourceFile: SourceFile,
  fileName: string,
  isCreateServerFnCall: (call: CallExpression, fileName: string) => boolean,
): string[] {
  const localPostServerFns = localPostServerFnBindings(sourceFile, fileName, isCreateServerFnCall);
  const exportsByLocal = exportedNamesByLocalBinding(sourceFile, localPostServerFns);
  const names = [...localPostServerFns].flatMap((localName) => {
    const exportedNames = exportsByLocal.get(localName);
    return exportedNames && exportedNames.length > 0 ? exportedNames : [localName];
  });

  for (const statement of sourceFile.statements) {
    if (
      isExportAssignment(statement) &&
      !statement.isExportEquals &&
      !isIdentifier(statement.expression) &&
      containsPostServerFn(statement.expression, sourceFile, fileName, isCreateServerFnCall)
    ) {
      names.push("default");
    }
  }
  return [...new Set(names)];
}

function exportedNamesByLocalBinding(
  sourceFile: SourceFile,
  localPostServerFns: ReadonlySet<string>,
): Map<string, string[]> {
  const exportsByLocal = new Map<string, string[]>();
  for (const [localName, exportedName] of sourceFile.statements.flatMap(exportedBindings)) {
    if (!localPostServerFns.has(localName)) continue;
    const names = exportsByLocal.get(localName) ?? [];
    names.push(exportedName);
    exportsByLocal.set(localName, names);
  }
  return exportsByLocal;
}

function exportedBindings(statement: Node): Array<readonly [string, string]> {
  if (isVariableStatement(statement) && isExported(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      isIdentifier(declaration.name)
        ? [[declaration.name.text, declaration.name.text] as const]
        : [],
    );
  }
  if (
    isExportDeclaration(statement) &&
    !statement.moduleSpecifier &&
    statement.exportClause &&
    isNamedExports(statement.exportClause)
  ) {
    return statement.exportClause.elements.map((element) => [
      element.propertyName?.text ?? element.name.text,
      element.name.text,
    ]);
  }
  return isExportAssignment(statement) &&
    !statement.isExportEquals &&
    isIdentifier(statement.expression)
    ? [[statement.expression.text, "default"]]
    : [];
}

function localPostServerFnBindings(
  sourceFile: SourceFile,
  fileName: string,
  isCreateServerFnCall: (call: CallExpression, fileName: string) => boolean,
): Set<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    for (const binding of postServerFnBindingsFromStatement(
      statement,
      sourceFile,
      fileName,
      isCreateServerFnCall,
    )) {
      bindings.add(binding);
    }
  }
  return bindings;
}

function postServerFnBindingsFromStatement(
  statement: Node,
  sourceFile: SourceFile,
  fileName: string,
  isCreateServerFnCall: (call: CallExpression, fileName: string) => boolean,
): string[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      isIdentifier(declaration.name) &&
      declaration.initializer &&
      containsPostServerFn(declaration.initializer, sourceFile, fileName, isCreateServerFnCall)
        ? [declaration.name.text]
        : [],
    );
  }
  if (
    !isExpressionStatement(statement) ||
    !isBinaryExpression(statement.expression) ||
    statement.expression.operatorToken.kind !== SyntaxKind.EqualsToken ||
    !isIdentifier(statement.expression.left)
  ) {
    return [];
  }
  return containsPostServerFn(
    statement.expression.right,
    sourceFile,
    fileName,
    isCreateServerFnCall,
  )
    ? [statement.expression.left.text]
    : [];
}

function containsPostServerFn(
  node: Node,
  sourceFile: SourceFile,
  fileName: string,
  isCreateServerFnCall: (call: CallExpression, fileName: string) => boolean,
): boolean {
  let found = false;
  visitNodes(node, (candidate) => {
    if (!isCallExpression(candidate) || !isCreateServerFnCall(candidate, fileName)) return;
    if (hasPostMethod(candidate, sourceFile, fileName)) found = true;
  });
  return found;
}

function hasPostMethod(call: CallExpression, sourceFile: SourceFile, fileName: string): boolean {
  const options = call.arguments[0];
  if (!options) return false;
  if (!isObjectLiteralExpression(options) || options.properties.some(isSpreadAssignment)) {
    throwUnresolvableMethod(call, sourceFile, fileName);
  }

  const methods = options.properties.filter(
    (property) => resolvedPropertyName(property, call, sourceFile, fileName) === "method",
  );
  if (methods.length === 0) return false;
  const [method] = methods;
  if (methods.length !== 1 || !method || !isPropertyAssignment(method)) {
    throwUnresolvableMethod(call, sourceFile, fileName);
  }
  if (!isStringLiteral(method.initializer)) throwUnresolvableMethod(call, sourceFile, fileName);
  return method.initializer.text === "POST";
}

function resolvedPropertyName(
  property: Node & { name?: Node },
  call: CallExpression,
  sourceFile: SourceFile,
  fileName: string,
): string {
  if (isSpreadAssignment(property) || !property.name) {
    throwUnresolvableMethod(call, sourceFile, fileName);
  }
  const name = propertyName(property.name);
  if (name === null) throwUnresolvableMethod(call, sourceFile, fileName);
  return name;
}

function throwUnresolvableMethod(
  call: CallExpression,
  sourceFile: SourceFile,
  fileName: string,
): never {
  throw new Error(
    `${fileName}: createServerFn() method is not statically resolvable: ${JSON.stringify(call.getText(sourceFile))}`,
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
