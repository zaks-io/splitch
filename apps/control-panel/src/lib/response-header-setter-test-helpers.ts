import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  type NamedImportBindings,
  type Node,
  type SourceFile,
} from "typescript";

/**
 * TanStack Start's `setResponseHeader("set-cookie", value)` is a Set-Cookie
 * write that never touches a `Headers` receiver, so the cookie sweep would not
 * see it through the `append`/`set` scan. This enumerates those calls by the
 * binding imported from the framework module so a server fn that sets a cookie
 * shows up in the sweep's allow-list like every other write site.
 */
const RESPONSE_HEADER_SETTER_MODULE = "@tanstack/react-start/server";
const RESPONSE_HEADER_SETTER = "setResponseHeader";

export interface SetterHeaderWrite {
  argument: string;
  method: "setResponseHeader";
}

export function responseHeaderSetterBindings(
  sourceFile: SourceFile,
  fileName: string,
): ReadonlySet<string> {
  return new Set(
    sourceFile.statements.flatMap((statement) => {
      if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) return [];
      if (statement.moduleSpecifier.text !== RESPONSE_HEADER_SETTER_MODULE) return [];
      return setterImportNames(statement.importClause?.namedBindings, fileName);
    }),
  );
}

function setterImportNames(
  namedBindings: NamedImportBindings | undefined,
  fileName: string,
): string[] {
  if (!namedBindings) return [];
  if (isNamespaceImport(namedBindings)) {
    throw new Error(
      `${fileName}: namespace import of ${RESPONSE_HEADER_SETTER_MODULE} hides ${RESPONSE_HEADER_SETTER}() calls from the Set-Cookie sweep; import it by name`,
    );
  }
  if (!isNamedImports(namedBindings)) return [];
  return namedBindings.elements.flatMap((element) =>
    (element.propertyName?.text ?? element.name.text) === RESPONSE_HEADER_SETTER
      ? [element.name.text]
      : [],
  );
}

export function setterHeaderWrite(
  node: Node,
  sourceFile: SourceFile,
  fileName: string,
  setterBindings: ReadonlySet<string>,
  headerNameBindings: Readonly<Record<string, string>>,
): SetterHeaderWrite | null {
  if (!isCallExpression(node) || !isIdentifier(node.expression)) return null;
  if (!setterBindings.has(node.expression.text)) return null;

  const [headerName, value] = node.arguments;
  const staticName = headerName ? staticString(headerName, headerNameBindings) : null;
  if (staticName !== null && staticName.toLowerCase() !== "set-cookie") return null;
  if (staticName === null) {
    const expression = headerName?.getText(sourceFile) ?? "<missing>";
    throw new Error(
      `${fileName}: ${RESPONSE_HEADER_SETTER}() has a non-literal header name: ${expression}`,
    );
  }
  return { argument: value?.getText(sourceFile) ?? "<missing>", method: RESPONSE_HEADER_SETTER };
}

export function importedHeaderNameBindings(
  sourceFile: SourceFile,
  modules: ReadonlyArray<{
    exports: Readonly<Record<string, string>>;
    moduleSpecifier: string;
  }>,
): Record<string, string> {
  const configured = new Map(modules.map((module) => [module.moduleSpecifier, module.exports]));
  return Object.fromEntries(
    sourceFile.statements.flatMap((statement) => importHeaderNameBindings(statement, configured)),
  );
}

function importHeaderNameBindings(
  statement: Node,
  configured: ReadonlyMap<string, Readonly<Record<string, string>>>,
): Array<[string, string]> {
  if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) return [];
  const exportedValues = configured.get(statement.moduleSpecifier.text);
  const namedBindings = statement.importClause?.namedBindings;
  if (!exportedValues || !namedBindings || !isNamedImports(namedBindings)) return [];
  return namedBindings.elements.flatMap((element) => {
    const importedName = element.propertyName?.text ?? element.name.text;
    const value = exportedValues[importedName];
    return Object.hasOwn(exportedValues, importedName) && value !== undefined
      ? [[element.name.text, value]]
      : [];
  });
}

export function staticString(
  expression: Expression,
  bindings: Readonly<Record<string, string>> = {},
): string | null {
  if (isStringLiteral(expression) || isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (isIdentifier(expression) && Object.hasOwn(bindings, expression.text)) {
    return bindings[expression.text] ?? null;
  }
  return null;
}
