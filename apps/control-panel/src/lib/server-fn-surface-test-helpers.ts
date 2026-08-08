import {
  type CallExpression,
  canHaveModifiers,
  getModifiers,
  isCallExpression,
  isExportAssignment,
  isExportDeclaration,
  isFunctionLike,
  isIdentifier,
  isNamedExports,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
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

  function postServerFns(sourceFile: SourceFile, fileName: string): string[] {
    const localPostServerFns: string[] = [];
    visitNodes(sourceFile, (candidate) => {
      if (
        !isCallExpression(candidate) ||
        !resolver.isCreateServerFnCall(candidate, sourceFile, fileName) ||
        !hasPostMethod(candidate, sourceFile, fileName)
      ) {
        return;
      }
      const binding = enclosingServerFnBinding(candidate);
      if (!binding) throwUnresolvableBinding(candidate, sourceFile, fileName);
      localPostServerFns.push(binding);
    });

    const exportsByLocal = exportedNamesByLocalBinding(sourceFile, new Set(localPostServerFns));
    return localPostServerFns.flatMap((localName) => {
      const exportedNames = exportsByLocal.get(localName);
      return exportedNames && exportedNames.length > 0 ? exportedNames : [localName];
    });
  }

  return {
    postServerFns(filePath, displayName) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile)
        throw new Error(`${displayName}: source file is absent from TypeScript program`);
      return postServerFns(sourceFile, displayName);
    },
  };
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

function enclosingServerFnBinding(call: CallExpression): string | null {
  let current: Node | undefined = call.parent;
  while (current) {
    const binding = bindingName(current);
    if (binding) return binding;
    if (isFunctionLike(current)) return null;
    current = current.parent;
  }
  return null;
}

function bindingName(node: Node): string | null {
  if (isVariableDeclaration(node) && isIdentifier(node.name)) return node.name.text;
  return isExportAssignment(node) && !node.isExportEquals ? "default" : null;
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

function throwUnresolvableBinding(
  call: CallExpression,
  sourceFile: SourceFile,
  fileName: string,
): never {
  throw new Error(
    `${fileName}: createServerFn POST is not assigned to a statically reviewable binding: ${JSON.stringify(call.getText(sourceFile))}`,
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
