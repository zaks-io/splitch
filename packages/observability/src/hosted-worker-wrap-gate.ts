import {
  type ArrowFunction,
  type Block,
  type ClassDeclaration,
  createSourceFile,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type IfStatement,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isMethodDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isThrowStatement,
  isTryStatement,
  isTypeAssertionExpression,
  isVariableStatement,
  type MethodDeclaration,
  type PropertyName,
  type SourceFile,
  ScriptKind,
  ScriptTarget,
  type Statement,
  SyntaxKind,
  type TryStatement,
} from "typescript";

export const WRAP_WORKER_HANDLER = "wrapWorkerHandler";

type PathResult = "returns" | "continues" | "fail";

export function defaultExportIsWrapped(source: string): boolean {
  const file = parseSource(source);
  const exported = findDefaultExport(file);
  return exported ? expressionIsWrap(file, exported, new Set()) : false;
}

export function exportedWorkerEntrypoints(source: string): string[] {
  const file = parseSource(source);
  const names: string[] = [];
  for (const statement of file.statements) {
    if (!isClassDeclaration(statement) || !isExported(statement) || !statement.name) continue;
    if (extendsWorkerEntrypoint(statement)) names.push(statement.name.text);
  }
  return names;
}

export function classFetchIsWrapped(source: string, className: string): boolean {
  const file = parseSource(source);
  const cls = file.statements.find(
    (statement): statement is ClassDeclaration =>
      isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!cls) return false;
  const fetch = cls.members.find(
    (member): member is MethodDeclaration =>
      isMethodDeclaration(member) && isFetchName(member.name),
  );
  if (!fetch?.body) return false;
  return (
    blockPath(file, fetch.body, (expression) => expressionIsWrappedFetch(file, expression)) ===
    "returns"
  );
}

function parseSource(source: string): SourceFile {
  return createSourceFile("worker.ts", source, ScriptTarget.Latest, true, ScriptKind.TS);
}

function findDefaultExport(file: SourceFile): Expression | undefined {
  for (const statement of file.statements) {
    if (isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  return undefined;
}

function isExported(node: ClassDeclaration): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword));
}

function extendsWorkerEntrypoint(cls: ClassDeclaration): boolean {
  return (cls.heritageClauses ?? []).some(
    (clause) =>
      clause.token === SyntaxKind.ExtendsKeyword &&
      clause.types.some(
        (type) => isIdentifier(type.expression) && type.expression.text === "WorkerEntrypoint",
      ),
  );
}

function isFetchName(name: PropertyName): boolean {
  return isIdentifier(name) && name.text === "fetch";
}

function expressionIsWrap(file: SourceFile, expression: Expression, seen: Set<string>): boolean {
  const value = unwrap(expression);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return functionReturnsWrap(file, value, seen);
  }
  if (isCallExpression(value)) {
    const callee = unwrap(value.expression);
    if (isIdentifier(callee) && callee.text === WRAP_WORKER_HANDLER) return true;
    return isIdentifier(callee) ? identifierIsWrap(file, callee.text, seen) : false;
  }
  return isIdentifier(value) ? identifierIsWrap(file, value.text, seen) : false;
}

function identifierIsWrap(file: SourceFile, name: string, seen: Set<string>): boolean {
  if (name === WRAP_WORKER_HANDLER) return true;
  if (seen.has(name)) return false;
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
  if (!isBlock(fn.body)) return expressionIsWrap(file, fn.body, seen);
  return (
    blockPath(file, fn.body, (expression) => expressionIsWrap(file, expression, seen)) === "returns"
  );
}

function expressionIsWrappedFetch(file: SourceFile, expression: Expression): boolean {
  const value = unwrap(expression);
  if (!isCallExpression(value) || !isPropertyAccessExpression(value.expression)) return false;
  if (value.expression.name.text !== "fetch") return false;
  const target = unwrap(value.expression.expression);
  if (isCallExpression(target)) return expressionIsWrap(file, target, new Set());
  return isIdentifier(target) ? identifierIsWrap(file, target.text, new Set()) : false;
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

function blockPath(
  file: SourceFile,
  block: Block,
  predicate: (expression: Expression) => boolean,
): PathResult {
  for (const statement of block.statements) {
    const result = statementPath(file, statement, predicate);
    if (result !== "continues") return result;
  }
  return "continues";
}

function statementPath(
  file: SourceFile,
  statement: Statement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  if (isReturnStatement(statement)) {
    return statement.expression && predicate(statement.expression) ? "returns" : "fail";
  }
  if (isThrowStatement(statement)) return "returns";
  if (isBlock(statement)) return blockPath(file, statement, predicate);
  if (isIfStatement(statement)) return ifPath(file, statement, predicate);
  if (isTryStatement(statement)) return tryPath(file, statement, predicate);
  return "continues";
}

function ifPath(
  file: SourceFile,
  statement: IfStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const thenPath = statementPath(file, statement.thenStatement, predicate);
  if (!statement.elseStatement) return thenPath === "fail" ? "fail" : "continues";
  const elsePath = statementPath(file, statement.elseStatement, predicate);
  if (thenPath === "fail" || elsePath === "fail") return "fail";
  return thenPath === "returns" && elsePath === "returns" ? "returns" : "continues";
}

function tryPath(
  file: SourceFile,
  statement: TryStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const tryResult = blockPath(file, statement.tryBlock, predicate);
  if (!statement.catchClause) return tryResult;
  const catchResult = blockPath(file, statement.catchClause.block, predicate);
  if (tryResult === "fail" || catchResult === "fail") return "fail";
  return tryResult === "returns" && catchResult === "returns" ? "returns" : "continues";
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
