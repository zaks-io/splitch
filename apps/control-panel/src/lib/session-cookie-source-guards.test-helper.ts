import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Expression,
  type ImportDeclaration,
  type Node,
  type SourceFile,
  type Statement,
  type VariableStatement,
} from "typescript";

export interface PostServerFn {
  name: string;
  reachesSession: boolean;
}

export interface SetCookieHeaderWrite {
  argument: string;
  method: "append" | "set";
}

export function exportedPostServerFns(
  source: string,
  fileName: string,
  sessionModules: ReadonlySet<string>,
): Array<PostServerFn> {
  const sourceFile = parse(source, fileName);
  const createServerFnBindings = importedBindings(
    sourceFile,
    new Set(["@tanstack/react-start"]),
    "createServerFn",
  );
  const sessionBindings = importedBindings(sourceFile, sessionModules);
  const localFunctions = localFunctionBodies(sourceFile);
  return sourceFile.statements.flatMap((statement) =>
    postServerFnsFromStatement(statement, createServerFnBindings, sessionBindings, localFunctions),
  );
}

export function setCookieHeaderWrites(
  source: string,
  fileName: string,
): Array<SetCookieHeaderWrite> {
  const sourceFile = parse(source, fileName);
  const writes: Array<SetCookieHeaderWrite> = [];

  visit(sourceFile, (node) => {
    if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    if (method !== "append" && method !== "set") return;

    const [headerName, value] = node.arguments;
    if (
      !headerName ||
      !isStringLiteral(headerName) ||
      headerName.text.toLowerCase() !== "set-cookie"
    ) {
      return;
    }

    writes.push({
      argument: value?.getText(sourceFile) ?? "<missing>",
      method,
    });
  });

  return writes;
}

function parse(source: string, fileName: string): SourceFile {
  const scriptKind = fileName.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS;
  return createSourceFile(fileName, source, ScriptTarget.Latest, true, scriptKind);
}

function isExported(node: Node): boolean {
  if (!canHaveModifiers(node)) return false;
  return (
    getModifiers(node)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ?? false
  );
}

function importedBindings(
  sourceFile: SourceFile,
  modules: ReadonlySet<string>,
  importedName?: string,
): Set<string> {
  return new Set(
    sourceFile.statements.flatMap((statement) =>
      importedBindingsFromStatement(statement, modules, importedName),
    ),
  );
}

function localFunctionBodies(sourceFile: SourceFile): Map<string, Node> {
  return new Map(sourceFile.statements.flatMap(localFunctionsFromStatement));
}

function postServerFnsFromStatement(
  statement: Statement,
  createServerFnBindings: ReadonlySet<string>,
  sessionBindings: ReadonlySet<string>,
  localFunctions: ReadonlyMap<string, Node>,
): Array<PostServerFn> {
  if (!isVariableStatement(statement) || !isExported(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => {
    if (!isIdentifier(declaration.name) || !declaration.initializer) return [];
    if (!containsPostServerFn(declaration.initializer, createServerFnBindings)) return [];
    return [
      {
        name: declaration.name.text,
        reachesSession: callsSessionBinding(
          declaration.initializer,
          sessionBindings,
          localFunctions,
          new Set(),
        ),
      },
    ];
  });
}

function importedBindingsFromStatement(
  statement: Statement,
  modules: ReadonlySet<string>,
  importedName: string | undefined,
): Array<string> {
  if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) return [];
  if (!modules.has(statement.moduleSpecifier.text) || !statement.importClause) return [];
  return bindingsFromImport(statement, importedName);
}

function bindingsFromImport(
  statement: ImportDeclaration,
  importedName: string | undefined,
): Array<string> {
  const clause = statement.importClause;
  if (!clause) return [];
  const defaultBinding = clause.name && !importedName ? [clause.name.text] : [];
  if (!clause.namedBindings) return defaultBinding;
  if (isNamespaceImport(clause.namedBindings)) {
    return importedName ? defaultBinding : [...defaultBinding, clause.namedBindings.name.text];
  }
  if (!isNamedImports(clause.namedBindings)) return defaultBinding;
  return [
    ...defaultBinding,
    ...clause.namedBindings.elements.flatMap((element) => {
      const originalName = element.propertyName?.text ?? element.name.text;
      return !importedName || originalName === importedName ? [element.name.text] : [];
    }),
  ];
}

function localFunctionsFromStatement(statement: Statement): Array<readonly [string, Node]> {
  if (isFunctionDeclaration(statement) && statement.name && statement.body) {
    return [[statement.name.text, statement.body]];
  }
  if (!isVariableStatement(statement)) return [];
  return localFunctionsFromVariables(statement);
}

function localFunctionsFromVariables(statement: VariableStatement): Array<readonly [string, Node]> {
  return statement.declarationList.declarations.flatMap((declaration) =>
    isIdentifier(declaration.name) && declaration.initializer
      ? ([[declaration.name.text, declaration.initializer]] as const)
      : [],
  );
}

function containsPostServerFn(node: Node, createServerFnBindings: ReadonlySet<string>): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (
      isCallExpression(candidate) &&
      isIdentifier(candidate.expression) &&
      createServerFnBindings.has(candidate.expression.text) &&
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
      property.name.getText() === "method" &&
      isStringLiteral(property.initializer) &&
      property.initializer.text === "POST",
  );
}

function callsSessionBinding(
  node: Node,
  sessionBindings: ReadonlySet<string>,
  localFunctions: ReadonlyMap<string, Node>,
  visitedFunctions: Set<string>,
): boolean {
  let reachesSession = false;
  visit(node, (candidate) => {
    if (callReachesSession(candidate, sessionBindings, localFunctions, visitedFunctions)) {
      reachesSession = true;
    }
  });
  return reachesSession;
}

function callReachesSession(
  node: Node,
  sessionBindings: ReadonlySet<string>,
  localFunctions: ReadonlyMap<string, Node>,
  visitedFunctions: Set<string>,
): boolean {
  if (!isCallExpression(node)) return false;
  const binding = calledBinding(node.expression);
  if (!binding) return false;
  if (sessionBindings.has(binding)) return true;

  const localFunction = localFunctions.get(binding);
  if (!localFunction || visitedFunctions.has(binding)) return false;
  visitedFunctions.add(binding);
  return callsSessionBinding(localFunction, sessionBindings, localFunctions, visitedFunctions);
}

function calledBinding(expression: Expression): string | null {
  if (isIdentifier(expression)) return expression.text;
  if (isPropertyAccessExpression(expression) && isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  return null;
}

function visit(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  forEachChild(node, (child) => visit(child, visitor));
}
