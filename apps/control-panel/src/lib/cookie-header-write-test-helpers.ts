import {
  type Expression,
  isArrayLiteralExpression,
  isAsExpression,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeAssertionExpression,
  type Node,
  type Program,
  type SourceFile,
  SymbolFlags,
  type Type,
  type TypeChecker,
  TypeFlags,
} from "typescript";
import {
  importedHeaderNameBindings,
  responseHeaderSetterBindings,
  setterHeaderWrite,
  staticString,
} from "./response-header-setter-test-helpers";
import { visitNodes } from "./source-file-test-helpers";

interface SetCookieHeaderWrite {
  argument: string;
  method: "append" | "entry" | "property" | "set" | "setResponseHeader";
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
      const setterBindings = responseHeaderSetterBindings(sourceFile);

      const writes: SetCookieHeaderWrite[] = [];
      visitNodes(sourceFile, (node) => {
        const found = [
          callHeaderWrite(node, sourceFile, displayName, headerNameBindings, checker, headersType),
          setterHeaderWrite(node, sourceFile, displayName, setterBindings, headerNameBindings),
          propertyHeaderWrite(node, sourceFile, displayName),
          entryHeaderWrite(node, sourceFile, displayName),
        ];
        for (const write of found) if (write) writes.push(write);
      });
      return writes;
    },
  };
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

  const [headerName, value] = node.arguments;
  const staticName = headerName ? staticString(headerName, headerNameBindings) : null;
  if (isOtherHeaderName(staticName)) return null;
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
  if (staticName === null) {
    const expression = headerName?.getText(sourceFile) ?? "<missing>";
    throw new Error(`${fileName}: ${method}() has a non-literal header name: ${expression}`);
  }
  return {
    argument: value?.getText(sourceFile) ?? "<missing>",
    method,
  };
}

const isOtherHeaderName = (name: string | null): boolean =>
  name !== null && name.toLowerCase() !== "set-cookie";

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
  return receiverType.isUnion()
    ? receiverType.types.some((member) => isHeadersType(member, checker, headersType))
    : isHeadersType(receiverType, checker, headersType);
}

function isHeadersType(type: Type, checker: TypeChecker, headersType: Type): boolean {
  if (type.flags & (TypeFlags.Undefined | TypeFlags.Null)) return false;
  return checker.isTypeAssignableTo(type, headersType);
}

function globalHeadersType(checker: TypeChecker): Type {
  const symbol = checker.resolveName("Headers", undefined, SymbolFlags.Type, false);
  if (!symbol) throw new Error("Cannot resolve the global Headers type");
  return checker.getDeclaredTypeOfSymbol(symbol);
}

function propertyHeaderWrite(
  node: Node,
  sourceFile: SourceFile,
  fileName: string,
): SetCookieHeaderWrite | null {
  if (!isPropertyAssignment(node)) return null;
  const name = staticPropertyName(node.name);
  if (name === null) {
    if (!isHeaderRecord(node.parent)) return null;
    throw new Error(
      `${fileName}: header property name is not statically resolvable: ${node.getText(sourceFile)}`,
    );
  }
  if (name.toLowerCase() !== "set-cookie") return null;
  return { argument: node.initializer.getText(sourceFile), method: "property" };
}

function entryHeaderWrite(
  node: Node,
  sourceFile: SourceFile,
  fileName: string,
): SetCookieHeaderWrite | null {
  if (!isArrayLiteralExpression(node)) return null;
  if (isHeaderEntryContainer(node)) {
    const unresolved = node.elements.find(
      (element) => isSpreadElement(element) || !isArrayLiteralExpression(element),
    );
    if (unresolved) {
      throw new Error(
        `${fileName}: header entry source is not statically resolvable: ${unresolved.getText(sourceFile)}`,
      );
    }
    return null;
  }
  if (!isArrayLiteralExpression(node.parent) || !isHeaderEntryContainer(node.parent)) return null;
  const [headerName, value] = node.elements;
  const name = headerName ? staticString(headerName) : null;
  if (name === null) {
    throw new Error(
      `${fileName}: header entry name is not statically resolvable: ${node.getText(sourceFile)}`,
    );
  }
  if (name.toLowerCase() !== "set-cookie") return null;
  return { argument: value?.getText(sourceFile) ?? "<missing>", method: "entry" };
}

function isHeaderRecord(node: Node): boolean {
  if (!isObjectLiteralExpression(node)) return false;
  const parent = node.parent;
  if (isPropertyAssignment(parent) && parent.initializer === node) {
    return staticPropertyName(parent.name)?.toLowerCase() === "headers";
  }
  return isHeadersConstructorArgument(node);
}

function isHeaderEntryContainer(node: Node): boolean {
  if (!isArrayLiteralExpression(node)) return false;
  const parent = node.parent;
  if (isPropertyAssignment(parent) && parent.initializer === node) {
    return staticPropertyName(parent.name)?.toLowerCase() === "headers";
  }
  return isHeadersConstructorArgument(node);
}

function isHeadersConstructorArgument(node: Node): boolean {
  const parent = node.parent;
  return (
    isNewExpression(parent) &&
    parent.arguments?.[0] === node &&
    isIdentifier(parent.expression) &&
    parent.expression.text === "Headers"
  );
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
