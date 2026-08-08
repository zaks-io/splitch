import {
  type CallExpression,
  canHaveModifiers,
  type Expression,
  getModifiers,
  isBinaryExpression,
  isCallExpression,
  isExportAssignment,
  isExportDeclaration,
  isExpressionStatement,
  isIdentifier,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { parseSourceFile, visitNodes } from "./source-file-test-helpers";

const TANSTACK_START = "@tanstack/react-start";

interface CreateServerFnBindings {
  direct: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
}

export function exportedPostServerFns(source: string, fileName: string): Array<string> {
  const sourceFile = parseSourceFile(source, fileName);
  const createServerFnBindings = importedCreateServerFnBindings(sourceFile);
  const localPostServerFns = localPostServerFnBindings(
    sourceFile,
    fileName,
    createServerFnBindings,
  );
  return [
    ...new Set(
      sourceFile.statements.flatMap((statement) => [
        ...directExportNames(statement, localPostServerFns),
        ...namedExportNames(statement, localPostServerFns),
        ...defaultExportNames(
          statement,
          sourceFile,
          fileName,
          localPostServerFns,
          createServerFnBindings,
        ),
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
  sourceFile: SourceFile,
  fileName: string,
  localPostServerFns: ReadonlySet<string>,
  createServerFnBindings: CreateServerFnBindings,
): string[] {
  if (!isExportAssignment(statement) || statement.isExportEquals) return [];
  if (isIdentifier(statement.expression) && localPostServerFns.has(statement.expression.text)) {
    return ["default"];
  }
  return containsPostServerFn(statement.expression, sourceFile, fileName, createServerFnBindings)
    ? ["default"]
    : [];
}

function localPostServerFnBindings(
  sourceFile: SourceFile,
  fileName: string,
  createServerFnBindings: CreateServerFnBindings,
): Set<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    for (const binding of postServerFnBindingsFromStatement(
      statement,
      sourceFile,
      fileName,
      createServerFnBindings,
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
  createServerFnBindings: CreateServerFnBindings,
): string[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      isIdentifier(declaration.name) &&
      declaration.initializer &&
      containsPostServerFn(declaration.initializer, sourceFile, fileName, createServerFnBindings)
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
    createServerFnBindings,
  )
    ? [statement.expression.left.text]
    : [];
}

function importedCreateServerFnBindings(sourceFile: SourceFile): CreateServerFnBindings {
  const imports = sourceFile.statements.map(createServerFnBindingsFromStatement);
  return {
    direct: new Set(imports.flatMap((bindings) => bindings.direct)),
    namespaces: new Set(imports.flatMap((bindings) => bindings.namespaces)),
  };
}

function createServerFnBindingsFromStatement(statement: Node): {
  direct: string[];
  namespaces: string[];
} {
  if (
    !isImportDeclaration(statement) ||
    !isStringLiteral(statement.moduleSpecifier) ||
    statement.moduleSpecifier.text !== TANSTACK_START
  ) {
    return { direct: [], namespaces: [] };
  }
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return { direct: [], namespaces: [] };
  if (isNamespaceImport(bindings)) return { direct: [], namespaces: [bindings.name.text] };
  if (!isNamedImports(bindings)) return { direct: [], namespaces: [] };
  return {
    direct: bindings.elements.flatMap((element) => {
      const importedName = element.propertyName?.text ?? element.name.text;
      return importedName === "createServerFn" ? [element.name.text] : [];
    }),
    namespaces: [],
  };
}

function containsPostServerFn(
  node: Node,
  sourceFile: SourceFile,
  fileName: string,
  bindings: CreateServerFnBindings,
): boolean {
  let found = false;
  visitNodes(node, (candidate) => {
    if (!isCallExpression(candidate) || !isCreateServerFnCall(candidate.expression, bindings))
      return;
    if (hasPostMethod(candidate, sourceFile, fileName)) found = true;
  });
  return found;
}

function isCreateServerFnCall(expression: Expression, bindings: CreateServerFnBindings): boolean {
  if (isIdentifier(expression)) return bindings.direct.has(expression.text);
  return (
    isPropertyAccessExpression(expression) &&
    expression.name.text === "createServerFn" &&
    isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text)
  );
}

function hasPostMethod(call: CallExpression, sourceFile: SourceFile, fileName: string): boolean {
  const options = call.arguments[0];
  if (
    !options ||
    !isObjectLiteralExpression(options) ||
    options.properties.some(isSpreadAssignment)
  ) {
    throwUnresolvableMethod(call, sourceFile, fileName);
  }
  const methods = options.properties
    .filter(isPropertyAssignment)
    .filter((property) => propertyName(property.name) === "method");
  if (methods.length !== 1) throwUnresolvableMethod(call, sourceFile, fileName);
  const [method] = methods;
  if (!method || !isStringLiteral(method.initializer)) {
    throwUnresolvableMethod(call, sourceFile, fileName);
  }
  return method.initializer.text === "POST";
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
