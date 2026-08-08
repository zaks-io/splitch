import {
  type Expression,
  isArrayLiteralExpression,
  isAsExpression,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTypeAssertionExpression,
  isVariableDeclaration,
  type Node,
  type SourceFile,
} from "typescript";
import { parseSourceFile, visitNodes } from "./source-file-test-helpers";

export interface SetCookieHeaderWrite {
  argument: string;
  method: "append" | "entry" | "property" | "set";
}

interface SetCookieHeaderWriteOptions {
  allowSerializedCookieAssertion?: boolean;
  headerNameModules?: ReadonlyArray<{
    exports: Readonly<Record<string, string>>;
    moduleSpecifier: string;
  }>;
}

export function setCookieHeaderWrites(
  source: string,
  fileName: string,
  options: SetCookieHeaderWriteOptions = {},
): Array<SetCookieHeaderWrite> {
  const sourceFile = parseSourceFile(source, fileName);
  assertCookieBrandProvenance(sourceFile, fileName, options);
  const headerNameBindings = importedHeaderNameBindings(
    sourceFile,
    options.headerNameModules ?? [],
  );
  const headerReceiverBindings = localHeaderReceiverBindings(sourceFile);

  const writes: Array<SetCookieHeaderWrite> = [];
  visitNodes(sourceFile, (node) => {
    const callWrite = callHeaderWrite(
      node,
      sourceFile,
      fileName,
      headerNameBindings,
      headerReceiverBindings,
    );
    if (callWrite) writes.push(callWrite);

    const propertyWrite = propertyHeaderWrite(node, sourceFile);
    if (propertyWrite) writes.push(propertyWrite);

    const entryWrite = entryHeaderWrite(node, sourceFile);
    if (entryWrite) writes.push(entryWrite);
  });
  return writes;
}

function importedHeaderNameBindings(
  sourceFile: SourceFile,
  modules: NonNullable<SetCookieHeaderWriteOptions["headerNameModules"]>,
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

function callHeaderWrite(
  node: Node,
  sourceFile: SourceFile,
  fileName: string,
  headerNameBindings: Readonly<Record<string, string>>,
  headerReceiverBindings: ReadonlySet<string>,
): SetCookieHeaderWrite | null {
  if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.text;
  if (method !== "append" && method !== "set") return null;
  if (!isHeaderReceiver(node.expression.expression, headerReceiverBindings)) return null;

  const [headerName, value] = node.arguments;
  const staticName = headerName ? staticString(headerName, headerNameBindings) : null;
  if (staticName === null) {
    const expression = headerName?.getText(sourceFile) ?? "<missing>";
    throw new Error(`${fileName}: ${method}() has a non-literal header name: ${expression}`);
  }
  if (staticName.toLowerCase() !== "set-cookie") return null;
  return {
    argument: value?.getText(sourceFile) ?? "<missing>",
    method,
  };
}

function propertyHeaderWrite(node: Node, sourceFile: SourceFile): SetCookieHeaderWrite | null {
  if (!isPropertyAssignment(node)) return null;
  const name = staticPropertyName(node.name);
  if (name?.toLowerCase() !== "set-cookie") return null;
  return { argument: node.initializer.getText(sourceFile), method: "property" };
}

function entryHeaderWrite(node: Node, sourceFile: SourceFile): SetCookieHeaderWrite | null {
  if (!isArrayLiteralExpression(node)) return null;
  const [headerName, value] = node.elements;
  const name = headerName ? staticString(headerName) : null;
  if (name?.toLowerCase() !== "set-cookie") return null;
  return { argument: value?.getText(sourceFile) ?? "<missing>", method: "entry" };
}

function assertCookieBrandProvenance(
  sourceFile: SourceFile,
  fileName: string,
  options: SetCookieHeaderWriteOptions,
): void {
  if (options.allowSerializedCookieAssertion) return;
  visitNodes(sourceFile, (node) => {
    if (!isAsExpression(node) && !isTypeAssertionExpression(node)) return;
    if (!/\bSerializedHttpOnlyCookie\b/.test(node.type.getText(sourceFile))) return;
    throw new Error(
      `${fileName}: SerializedHttpOnlyCookie assertion bypasses serializer provenance: ${node.getText(sourceFile)}`,
    );
  });
}

function localHeaderReceiverBindings(sourceFile: SourceFile): Set<string> {
  const bindings = new Set<string>();
  visitNodes(sourceFile, (node) => {
    if (!isVariableDeclaration(node) || !isIdentifier(node.name) || !node.initializer) return;
    if (isHeaderReceiver(node.initializer, bindings)) bindings.add(node.name.text);
  });
  return bindings;
}

function isHeaderReceiver(receiver: Expression, bindings: ReadonlySet<string>): boolean {
  if (isIdentifier(receiver))
    return /headers?$/i.test(receiver.text) || bindings.has(receiver.text);
  if (isPropertyAccessExpression(receiver)) return receiver.name.text.toLowerCase() === "headers";
  return (
    isNewExpression(receiver) &&
    isIdentifier(receiver.expression) &&
    receiver.expression.text === "Headers"
  );
}

function staticPropertyName(name: Node): string | null {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (isComputedPropertyName(name)) return staticString(name.expression);
  return null;
}

function staticString(
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
