import {
  type ArrowFunction,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSpreadAssignment,
  isStringLiteral,
  isTypeAssertionExpression,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  type SourceFile,
  type Statement,
} from "typescript";
import { blockPath } from "./hosted-worker-wrap-path";

export const WRAP_WORKER_HANDLER = "wrapWorkerHandler";
const APPLY_RESPONSE_HEADERS = "applyResponseHeaders";
const WORKER_BASELINE = "WORKER_BASELINE_SECURITY_HEADERS";
const OFFICIAL_WRAPPER_MODULE = "@splitch/observability/worker";
const OFFICIAL_HEADERS_MODULE = "@splitch/worker-runtime";

export type FunctionLike =
  | FunctionDeclaration
  | ArrowFunction
  | FunctionExpression
  | MethodDeclaration;

export function fetchReturnIsWrapped(
  file: SourceFile,
  expression: Expression,
  fn: FunctionLike,
): boolean {
  return (
    expressionIsWrappedFetch(file, expression, fn) || expressionAppliesBaseline(file, expression)
  );
}

export function expressionIsWrap(
  file: SourceFile,
  expression: Expression,
  seen: Set<string>,
  fn?: FunctionLike,
): boolean {
  const value = unwrap(expression);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return functionReturnsWrap(file, value, seen);
  }
  if (isCallExpression(value)) {
    return calleeIsOfficialWrap(file, unwrap(value.expression), seen, fn);
  }
  return isIdentifier(value) ? identifierIsWrap(file, value.text, seen, fn) : false;
}

function calleeIsOfficialWrap(
  file: SourceFile,
  callee: Expression,
  seen: Set<string>,
  fn?: FunctionLike,
): boolean {
  if (isOfficialPropertyAccess(file, callee, WRAP_WORKER_HANDLER, OFFICIAL_WRAPPER_MODULE)) {
    return true;
  }
  return isIdentifier(callee) ? identifierIsWrap(file, callee.text, seen, fn) : false;
}

function identifierIsWrap(
  file: SourceFile,
  name: string,
  seen: Set<string>,
  fn?: FunctionLike,
): boolean {
  if (seen.has(name)) return false;
  const local = fn ? findLocalBinding(fn, name) : undefined;
  if (local !== undefined) {
    seen.add(name);
    return isFunctionDeclaration(local)
      ? functionReturnsWrap(file, local, seen)
      : expressionIsWrap(file, local, seen, fn);
  }
  if (importedNameIs(file, name, WRAP_WORKER_HANDLER, OFFICIAL_WRAPPER_MODULE)) return true;
  seen.add(name);
  const binding = findModuleBinding(file, name);
  if (!binding) return false;
  if (isFunctionDeclaration(binding)) return functionReturnsWrap(file, binding, seen);
  return expressionIsWrap(file, binding, seen);
}

function functionReturnsWrap(
  file: SourceFile,
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  seen: Set<string>,
): boolean {
  if (!fn.body) return false;
  if (!isBlock(fn.body)) return expressionIsWrap(file, fn.body, seen, fn);
  return (
    blockPath(fn.body, (expression) => expressionIsWrap(file, expression, seen, fn)) === "returns"
  );
}

function expressionIsWrappedFetch(
  file: SourceFile,
  expression: Expression,
  fn: FunctionLike,
): boolean {
  const value = unwrap(expression);
  if (!isCallExpression(value) || !isPropertyAccessExpression(value.expression)) return false;
  if (value.expression.name.text !== "fetch") return false;
  const target = unwrap(value.expression.expression);
  if (isCallExpression(target)) return expressionIsWrap(file, target, new Set(), fn);
  return isIdentifier(target) ? identifierIsWrap(file, target.text, new Set(), fn) : false;
}

function expressionAppliesBaseline(file: SourceFile, expression: Expression): boolean {
  const value = unwrap(expression);
  if (!isCallExpression(value)) return false;
  const headers = value.arguments[1];
  if (headers === undefined) return false;
  const callee = unwrap(value.expression);
  const officialCall =
    isOfficialPropertyAccess(file, callee, APPLY_RESPONSE_HEADERS, OFFICIAL_HEADERS_MODULE) ||
    (isIdentifier(callee) &&
      importedNameIs(file, callee.text, APPLY_RESPONSE_HEADERS, OFFICIAL_HEADERS_MODULE));
  return officialCall && argumentIsOfficialBaseline(file, headers);
}

function argumentIsOfficialBaseline(file: SourceFile, argument: Expression): boolean {
  const value = unwrap(argument);
  if (isIdentifier(value)) {
    return importedNameIs(file, value.text, WORKER_BASELINE, OFFICIAL_HEADERS_MODULE);
  }
  if (!isObjectLiteralExpression(value) || value.properties.length !== 1) return false;
  const only = value.properties[0];
  if (!only || !isSpreadAssignment(only)) return false;
  const spread = unwrap(only.expression);
  return (
    isIdentifier(spread) &&
    importedNameIs(file, spread.text, WORKER_BASELINE, OFFICIAL_HEADERS_MODULE)
  );
}

function importedNameIs(
  file: SourceFile,
  localName: string,
  exported: string,
  moduleName: string,
): boolean {
  return file.statements.some((statement) =>
    namedImportMatches(statement, localName, exported, moduleName),
  );
}

function namedImportMatches(
  statement: Statement,
  localName: string,
  exported: string,
  moduleName: string,
): boolean {
  if (!isImportDeclaration(statement) || !isModule(statement.moduleSpecifier, moduleName)) {
    return false;
  }
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !isNamedImports(bindings)) return false;
  return bindings.elements.some((spec) => {
    const imported = spec.propertyName?.text ?? spec.name.text;
    return imported === exported && spec.name.text === localName;
  });
}

function isOfficialPropertyAccess(
  file: SourceFile,
  expression: Expression,
  exported: string,
  moduleName: string,
): boolean {
  if (!isPropertyAccessExpression(expression) || expression.name.text !== exported) return false;
  const object = unwrap(expression.expression);
  if (!isIdentifier(object)) return false;
  return file.statements.some((statement) => namespaceImportIs(statement, object.text, moduleName));
}

function namespaceImportIs(statement: Statement, localName: string, moduleName: string): boolean {
  if (!isImportDeclaration(statement) || !isModule(statement.moduleSpecifier, moduleName)) {
    return false;
  }
  const bindings = statement.importClause?.namedBindings;
  return Boolean(bindings && isNamespaceImport(bindings) && bindings.name.text === localName);
}

function isModule(specifier: Node, moduleName: string): boolean {
  return isStringLiteral(specifier) && specifier.text === moduleName;
}

function findModuleBinding(
  file: SourceFile,
  name: string,
): Expression | FunctionDeclaration | undefined {
  for (const statement of file.statements) {
    const found = bindingFromStatement(statement, name);
    if (found) return found;
  }
  return undefined;
}

function findLocalBinding(
  fn: FunctionLike,
  name: string,
): Expression | FunctionDeclaration | undefined {
  if (!fn.body || !isBlock(fn.body)) return undefined;
  return findBindingInStatements(fn.body.statements, name);
}

function findBindingInStatements(
  statements: readonly Statement[],
  name: string,
): Expression | FunctionDeclaration | undefined {
  for (const statement of statements) {
    const found = bindingFromStatement(statement, name);
    if (found) return found;
    if (isBlock(statement)) {
      const nested = findBindingInStatements(statement.statements, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function bindingFromStatement(
  statement: Statement,
  name: string,
): Expression | FunctionDeclaration | undefined {
  if (isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  if (!isVariableStatement(statement)) return undefined;
  for (const declaration of statement.declarationList.declarations) {
    if (isIdentifier(declaration.name) && declaration.name.text === name) {
      return declaration.initializer;
    }
  }
  return undefined;
}

function unwrap(expression: Expression): Expression {
  let current = expression;
  for (;;) {
    const next = unwrapOnce(current);
    if (!next) return current;
    current = next;
  }
}

function unwrapOnce(expression: Expression): Expression | undefined {
  if (isParenthesizedExpression(expression)) return expression.expression;
  if (isAsExpression(expression) || isSatisfiesExpression(expression)) return expression.expression;
  if (isNonNullExpression(expression) || isAwaitExpression(expression))
    return expression.expression;
  if (isTypeAssertionExpression(expression)) return expression.expression;
  return undefined;
}
