import {
  type Expression,
  isArrayLiteralExpression,
  isAsExpression,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTypeAssertionExpression,
  type Node,
  type Program,
  type SourceFile,
  SymbolFlags,
  type Type,
  TypeFlags,
  type TypeChecker,
} from "typescript";
import { visitNodes } from "./source-file-test-helpers";

interface SetCookieHeaderWrite {
  argument: string;
  method: "append" | "entry" | "property" | "set";
}

interface CookieHeaderWriteDiscoveryOptions {
  headerNameModules?: ReadonlyArray<{
    exports: Readonly<Record<string, string>>;
    moduleSpecifier: string;
  }>;
}

interface SetCookieHeaderWriteOptions {
  allowSerializedCookieAssertion?: boolean;
}

export interface CookieHeaderWriteDiscovery {
  setCookieHeaderWrites(
    filePath: string,
    displayName: string,
    options?: SetCookieHeaderWriteOptions,
  ): SetCookieHeaderWrite[];
}

export function createCookieHeaderWriteDiscovery(
  program: Program,
  discoveryOptions: CookieHeaderWriteDiscoveryOptions = {},
): CookieHeaderWriteDiscovery {
  const checker = program.getTypeChecker();
  const headersType = globalHeadersType(checker);

  return {
    setCookieHeaderWrites(filePath, displayName, options = {}) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) {
        throw new Error(`${displayName}: source file is absent from TypeScript program`);
      }
      assertCookieBrandProvenance(sourceFile, displayName, options);
      const headerNameBindings = importedHeaderNameBindings(
        sourceFile,
        discoveryOptions.headerNameModules ?? [],
      );

      const writes: SetCookieHeaderWrite[] = [];
      visitNodes(sourceFile, (node) => {
        const callWrite = callHeaderWrite(
          node,
          sourceFile,
          displayName,
          headerNameBindings,
          checker,
          headersType,
        );
        if (callWrite) writes.push(callWrite);

        const propertyWrite = propertyHeaderWrite(node, sourceFile);
        if (propertyWrite) writes.push(propertyWrite);

        const entryWrite = entryHeaderWrite(node, sourceFile);
        if (entryWrite) writes.push(entryWrite);
      });
      return writes;
    },
  };
}

function importedHeaderNameBindings(
  sourceFile: SourceFile,
  modules: NonNullable<CookieHeaderWriteDiscoveryOptions["headerNameModules"]>,
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
  checker: TypeChecker,
  headersType: Type,
): SetCookieHeaderWrite | null {
  if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.text;
  if (method !== "append" && method !== "set") return null;
  if (
    !isHeadersReceiver(
      node.expression.expression,
      method,
      sourceFile,
      fileName,
      checker,
      headersType,
    )
  ) {
    return null;
  }

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

function isHeadersReceiver(
  receiver: Expression,
  method: "append" | "set",
  sourceFile: SourceFile,
  fileName: string,
  checker: TypeChecker,
  headersType: Type,
): boolean {
  const receiverType = checker.getTypeAtLocation(receiver);
  if (receiverType.flags & (TypeFlags.Any | TypeFlags.Unknown)) {
    throw new Error(
      `${fileName}: ${method}() receiver type is not statically resolvable: ${receiver.getText(sourceFile)}`,
    );
  }
  return checker.isTypeAssignableTo(receiverType, headersType);
}

function globalHeadersType(checker: TypeChecker): Type {
  const symbol = checker.resolveName("Headers", undefined, SymbolFlags.Type, false);
  if (!symbol) throw new Error("Cannot resolve the global Headers type");
  return checker.getDeclaredTypeOfSymbol(symbol);
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
