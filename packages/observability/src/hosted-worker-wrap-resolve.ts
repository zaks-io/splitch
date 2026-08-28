import {
  type ArrowFunction,
  type Block,
  type CallExpression,
  type ConditionalExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isCatchClause,
  isClassDeclaration,
  isConditionalExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedImports,
  isNamespaceImport,
  isPropertyAccessExpression,
  isSourceFile,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  type Statement,
} from "typescript";
import { blockPath, fail, type PathResult, RETURNS, unwrap } from "./hosted-worker-wrap-ast.js";

export const WRAP_WORKER_HANDLER = "wrapWorkerHandler";

const OFFICIAL_WRAP_WORKER_HANDLER_SPECIFIERS = [
  "@splitch/worker-runtime",
  "@splitch/observability/worker",
] as const;

function expressionIsWrap(file: SourceFile, expression: Expression, seen: Set<string>): boolean {
  return expressionWrapPath(file, expression, seen).kind === "returns";
}

export function expressionWrapPath(
  file: SourceFile,
  expression: Expression,
  seen: Set<string>,
): PathResult {
  const value = unwrap(expression);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return functionWrapPath(file, value, seen);
  }
  if (isConditionalExpression(value)) return bothBranchesWrap(file, value, seen);
  if (isCallExpression(value)) return callWrapPath(file, value, seen);
  if (isIdentifier(value)) return identifierWrapPath(file, value.text, seen, value);
  return fail(file, value, "default export is not the official wrapWorkerHandler binding");
}

export function functionWrapPath(
  file: SourceFile,
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  seen: Set<string>,
): PathResult {
  if (!fn.body) return fail(file, fn, "function has no body");
  if (!isBlock(fn.body)) return expressionWrapPath(file, fn.body, seen);
  const path = blockPath(file, fn.body, (expression) => expressionIsWrap(file, expression, seen));
  if (path.kind === "returns" || path.kind === "fail") return path;
  return fail(file, fn.body, "not every reachable path returns a wrapped handler");
}

export function expressionIsWrappedFetch(file: SourceFile, expression: Expression): boolean {
  const value = unwrap(expression);
  if (isConditionalExpression(value)) {
    return (
      expressionIsWrappedFetch(file, value.whenTrue) &&
      expressionIsWrappedFetch(file, value.whenFalse)
    );
  }
  if (!isCallExpression(value) || !isPropertyAccessExpression(value.expression)) return false;
  if (value.expression.name.text !== "fetch") return false;
  const target = unwrap(value.expression.expression);
  if (isCallExpression(target)) return expressionIsWrap(file, target, new Set());
  return isIdentifier(target) ? identifierIsWrap(file, target.text, new Set()) : false;
}

function bothBranchesWrap(
  file: SourceFile,
  value: ConditionalExpression,
  seen: Set<string>,
): PathResult {
  const whenTrue = requireWrapped(file, value.whenTrue, seen);
  if (whenTrue.kind !== "returns") return whenTrue;
  return requireWrapped(file, value.whenFalse, seen);
}

function requireWrapped(file: SourceFile, expression: Expression, seen: Set<string>): PathResult {
  const path = expressionWrapPath(file, expression, seen);
  return path.kind === "returns" || path.kind === "fail"
    ? path
    : fail(file, expression, "unwrapped response path");
}

function callWrapPath(file: SourceFile, value: CallExpression, seen: Set<string>): PathResult {
  if (isOfficialWrapCall(file, value)) return RETURNS;
  const callee = unwrap(value.expression);
  if (isIdentifier(callee)) return identifierWrapPath(file, callee.text, seen, callee);
  return fail(file, value, "unwrapped response path");
}

function identifierWrapPath(
  file: SourceFile,
  name: string,
  seen: Set<string>,
  node: Node,
): PathResult {
  if (isOfficialWrapBinding(file, name, node)) {
    return fail(file, node, "wrapWorkerHandler itself is not a wrapped handler");
  }
  if (seen.has(name)) return fail(file, node, "circular wrap alias");
  seen.add(name);
  const binding = findModuleBinding(file, name);
  if (!binding) return fail(file, node, `unresolved identifier ${name}`);
  if (isFunctionDeclaration(binding)) return functionWrapPath(file, binding, seen);
  return expressionWrapPath(file, binding, seen);
}

function identifierIsWrap(file: SourceFile, name: string, seen: Set<string>): boolean {
  return identifierWrapPath(file, name, seen, file).kind === "returns";
}

function isOfficialWrapCall(file: SourceFile, expression: Expression): boolean {
  const value = unwrap(expression);
  if (!isCallExpression(value)) return false;
  const callee = unwrap(value.expression);
  if (isIdentifier(callee)) return isOfficialWrapBinding(file, callee.text, callee);
  if (
    isPropertyAccessExpression(callee) &&
    isIdentifier(callee.name) &&
    callee.name.text === WRAP_WORKER_HANDLER
  ) {
    const object = unwrap(callee.expression);
    return isIdentifier(object) && isOfficialWrapNamespace(file, object.text, object);
  }
  return false;
}

function isOfficialWrapBinding(file: SourceFile, name: string, node: Node): boolean {
  if (nameIsBoundInEnclosingScope(node, name) || localModuleValueNames(file).has(name)) {
    return false;
  }
  return officialImportedWrapNames(file).has(name);
}

function isOfficialWrapNamespace(file: SourceFile, name: string, node: Node): boolean {
  if (nameIsBoundInEnclosingScope(node, name) || localModuleValueNames(file).has(name)) {
    return false;
  }
  return officialImportedWrapNamespaces(file).has(name);
}

function nameIsBoundInEnclosingScope(node: Node, name: string): boolean {
  let current: Node | undefined = node.parent;
  while (current && !isSourceFile(current)) {
    if (scopeBindsName(current, name)) return true;
    current = current.parent;
  }
  return false;
}

function scopeBindsName(scope: Node, name: string): boolean {
  if (isFunctionDeclaration(scope) || isFunctionExpression(scope) || isArrowFunction(scope)) {
    return functionLikeBindsName(scope, name);
  }
  if (isMethodDeclaration(scope) || isConstructorDeclaration(scope)) {
    return parametersBindName(scope.parameters, name);
  }
  if (isBlock(scope)) return blockBindsName(scope, name);
  return catchBindsName(scope, name);
}

function functionLikeBindsName(
  fn: FunctionDeclaration | FunctionExpression | ArrowFunction,
  name: string,
): boolean {
  if (fn.name && isIdentifier(fn.name) && fn.name.text === name) return true;
  return parametersBindName(fn.parameters, name);
}

function parametersBindName(parameters: readonly ParameterDeclaration[], name: string): boolean {
  return parameters.some(
    (parameter) => isIdentifier(parameter.name) && parameter.name.text === name,
  );
}

function blockBindsName(block: Block, name: string): boolean {
  const names = new Set<string>();
  for (const statement of block.statements) addLocalValueName(statement, names);
  return names.has(name);
}

function catchBindsName(scope: Node, name: string): boolean {
  if (!isCatchClause(scope) || !scope.variableDeclaration) return false;
  return (
    isIdentifier(scope.variableDeclaration.name) && scope.variableDeclaration.name.text === name
  );
}

function officialImportedWrapNames(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) addOfficialNamedWrapImports(statement, names);
  return names;
}

function addOfficialNamedWrapImports(statement: Statement, names: Set<string>): void {
  if (!isImportDeclaration(statement) || !isOfficialWrapSpecifier(statement.moduleSpecifier)) {
    return;
  }
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !isNamedImports(bindings)) return;
  for (const element of bindings.elements) {
    const imported = (element.propertyName ?? element.name).text;
    if (imported === WRAP_WORKER_HANDLER) names.add(element.name.text);
  }
}

function officialImportedWrapNamespaces(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!isImportDeclaration(statement) || !isOfficialWrapSpecifier(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && isNamespaceImport(bindings)) names.add(bindings.name.text);
  }
  return names;
}

function isOfficialWrapSpecifier(specifier: Expression): boolean {
  return (
    isStringLiteral(specifier) &&
    (OFFICIAL_WRAP_WORKER_HANDLER_SPECIFIERS as readonly string[]).includes(specifier.text)
  );
}

function localModuleValueNames(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) addLocalValueName(statement, names);
  return names;
}

function addLocalValueName(statement: Statement, names: Set<string>): void {
  if (isFunctionDeclaration(statement) && statement.name) names.add(statement.name.text);
  if (isClassDeclaration(statement) && statement.name) names.add(statement.name.text);
  if (!isVariableStatement(statement)) return;
  for (const declaration of statement.declarationList.declarations) {
    if (isIdentifier(declaration.name)) names.add(declaration.name.text);
  }
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
