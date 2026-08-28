import {
  type Block,
  type CaseOrDefaultClause,
  type DoStatement,
  type Expression,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type IfStatement,
  isAsExpression,
  isAwaitExpression,
  isBlock,
  isBreakStatement,
  isClassDeclaration,
  isContinueStatement,
  isDebuggerStatement,
  isDefaultClause,
  isDoStatement,
  isEmptyStatement,
  isEnumDeclaration,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isIfStatement,
  isInterfaceDeclaration,
  isLabeledStatement,
  isNonNullExpression,
  isParenthesizedExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isSwitchStatement,
  isThrowStatement,
  isTryStatement,
  isTypeAliasDeclaration,
  isTypeAssertionExpression,
  isVariableStatement,
  isWhileStatement,
  type Node,
  type ReturnStatement,
  type SourceFile,
  type Statement,
  type SwitchStatement,
  SyntaxKind,
  type TryStatement,
  type WhileStatement,
} from "typescript";

export type PathResult =
  | { readonly kind: "returns" }
  | { readonly kind: "continues" }
  | { readonly kind: "fail"; readonly reason: string; readonly location: string };

export const RETURNS: PathResult = { kind: "returns" };
const CONTINUES: PathResult = { kind: "continues" };

export function fail(file: SourceFile, node: Node, reason: string): PathResult {
  return { kind: "fail", reason, location: locationOf(file, node) };
}

export function locationOf(file: SourceFile, node: Node): string {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `${file.fileName}:${line + 1}:${character + 1}`;
}

export function unwrap(expression: Expression): Expression {
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
  if (isNonNullExpression(expression) || isAwaitExpression(expression)) {
    return expression.expression;
  }
  if (isTypeAssertionExpression(expression)) return expression.expression;
  return undefined;
}

export function blockPath(
  file: SourceFile,
  block: Block,
  predicate: (expression: Expression) => boolean,
): PathResult {
  for (const statement of block.statements) {
    const result = statementPath(file, statement, predicate);
    if (result.kind !== "continues") return result;
  }
  return CONTINUES;
}

function statementPath(
  file: SourceFile,
  statement: Statement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const structured = structuredStatementPath(file, statement, predicate);
  if (structured) return structured;
  if (isBreakStatement(statement) || isContinueStatement(statement)) return CONTINUES;
  if (isLabeledStatement(statement)) return statementPath(file, statement.statement, predicate);
  if (isBenignStatement(statement)) return CONTINUES;
  return fail(file, statement, `unsupported syntax ${SyntaxKind[statement.kind]}`);
}

function structuredStatementPath(
  file: SourceFile,
  statement: Statement,
  predicate: (expression: Expression) => boolean,
): PathResult | undefined {
  if (isReturnStatement(statement)) return returnPath(file, statement, predicate);
  if (isThrowStatement(statement)) return RETURNS;
  if (isBlock(statement)) return blockPath(file, statement, predicate);
  if (isIfStatement(statement)) return ifPath(file, statement, predicate);
  if (isTryStatement(statement)) return tryPath(file, statement, predicate);
  if (isSwitchStatement(statement)) return switchPath(file, statement, predicate);
  if (isLoopStatement(statement)) {
    return loopPath(file, statement.statement, predicate, loopAlwaysRuns(statement));
  }
  return undefined;
}

function returnPath(
  file: SourceFile,
  statement: ReturnStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  if (!statement.expression) {
    return fail(file, statement, "bare return is not a wrapped handler");
  }
  return predicate(statement.expression)
    ? RETURNS
    : fail(file, statement, "unwrapped response path");
}

function isLoopStatement(
  statement: Statement,
): statement is ForStatement | ForInStatement | ForOfStatement | WhileStatement | DoStatement {
  return (
    isForStatement(statement) ||
    isForInStatement(statement) ||
    isForOfStatement(statement) ||
    isWhileStatement(statement) ||
    isDoStatement(statement)
  );
}

function isBenignStatement(statement: Statement): boolean {
  return (
    isVariableStatement(statement) ||
    isExpressionStatement(statement) ||
    isEmptyStatement(statement) ||
    isDebuggerStatement(statement) ||
    isFunctionDeclaration(statement) ||
    isClassDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    isEnumDeclaration(statement)
  );
}

function ifPath(
  file: SourceFile,
  statement: IfStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const thenPath = statementPath(file, statement.thenStatement, predicate);
  if (thenPath.kind === "fail") return thenPath;
  if (!statement.elseStatement) return CONTINUES;
  const elsePath = statementPath(file, statement.elseStatement, predicate);
  if (elsePath.kind === "fail") return elsePath;
  return thenPath.kind === "returns" && elsePath.kind === "returns" ? RETURNS : CONTINUES;
}

function tryPath(
  file: SourceFile,
  statement: TryStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const tryResult = blockPath(file, statement.tryBlock, predicate);
  const catchResult = statement.catchClause
    ? blockPath(file, statement.catchClause.block, predicate)
    : undefined;
  const finallyResult = statement.finallyBlock
    ? blockPath(file, statement.finallyBlock, predicate)
    : CONTINUES;
  if (finallyResult.kind === "fail" || finallyResult.kind === "returns") return finallyResult;
  if (tryResult.kind === "fail") return tryResult;
  if (!catchResult) return tryResult;
  if (catchResult.kind === "fail") return catchResult;
  return tryResult.kind === "returns" && catchResult.kind === "returns" ? RETURNS : CONTINUES;
}

function switchPath(
  file: SourceFile,
  statement: SwitchStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const clauses = statement.caseBlock.clauses;
  if (clauses.length === 0) return CONTINUES;
  const paths = clauses.map((_, index) => clauseFallthroughPath(file, clauses, index, predicate));
  const failed = paths.find((path) => path.kind === "fail");
  if (failed) return failed;
  const hasDefault = clauses.some((clause) => isDefaultClause(clause));
  const allReturn = paths.every((path) => path.kind === "returns");
  return hasDefault && allReturn ? RETURNS : CONTINUES;
}

function clauseFallthroughPath(
  file: SourceFile,
  clauses: readonly CaseOrDefaultClause[],
  start: number,
  predicate: (expression: Expression) => boolean,
): PathResult {
  for (let index = start; index < clauses.length; index += 1) {
    const result = clauseStatementsPath(file, clauses[index], predicate);
    if (result.kind !== "continues") return result;
  }
  return CONTINUES;
}

function clauseStatementsPath(
  file: SourceFile,
  clause: CaseOrDefaultClause | undefined,
  predicate: (expression: Expression) => boolean,
): PathResult {
  if (!clause) return CONTINUES;
  for (const statement of clause.statements) {
    if (isBreakStatement(statement) && !statement.label) return CONTINUES;
    const result = statementPath(file, statement, predicate);
    if (result.kind !== "continues") return result;
  }
  return CONTINUES;
}

function loopPath(
  file: SourceFile,
  body: Statement,
  predicate: (expression: Expression) => boolean,
  alwaysRuns: boolean,
): PathResult {
  const bodyResult = statementPath(file, body, predicate);
  if (bodyResult.kind === "fail") return bodyResult;
  if (alwaysRuns && bodyResult.kind === "returns") return RETURNS;
  return CONTINUES;
}

function loopAlwaysRuns(
  statement: ForStatement | ForInStatement | ForOfStatement | WhileStatement | DoStatement,
): boolean {
  if (isForInStatement(statement) || isForOfStatement(statement)) return false;
  if (isForStatement(statement)) {
    return statement.condition === undefined || isTrueLiteral(statement.condition);
  }
  return isTrueLiteral(statement.expression);
}

function isTrueLiteral(expression: Expression): boolean {
  return unwrap(expression).kind === SyntaxKind.TrueKeyword;
}
