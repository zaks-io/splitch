import {
  type Block,
  type Expression,
  type IfStatement,
  isBlock,
  isBreakStatement,
  isDefaultClause,
  isIfStatement,
  isReturnStatement,
  isSwitchStatement,
  isThrowStatement,
  isTryStatement,
  type NodeArray,
  type Statement,
  type SwitchStatement,
  type TryStatement,
} from "typescript";

export type PathResult = "returns" | "continues" | "fail" | "breaks";

export function blockPath(
  block: Block,
  predicate: (expression: Expression) => boolean,
): PathResult {
  return normalize(statementsPath(block.statements, predicate));
}

function statementsPath(
  statements: NodeArray<Statement> | readonly Statement[],
  predicate: (expression: Expression) => boolean,
): PathResult {
  for (const statement of statements) {
    const result = statementPath(statement, predicate);
    if (result !== "continues") return result;
  }
  return "continues";
}

function statementPath(
  statement: Statement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  if (isReturnStatement(statement)) {
    return statement.expression && predicate(statement.expression) ? "returns" : "fail";
  }
  if (isThrowStatement(statement)) return "returns";
  if (isBreakStatement(statement)) return "breaks";
  if (isBlock(statement)) return statementsPath(statement.statements, predicate);
  if (isIfStatement(statement)) return ifPath(statement, predicate);
  if (isSwitchStatement(statement)) return switchPath(statement, predicate);
  if (isTryStatement(statement)) return tryPath(statement, predicate);
  return "continues";
}

function ifPath(
  statement: IfStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const thenPath = statementPath(statement.thenStatement, predicate);
  if (!statement.elseStatement) return thenPath === "fail" ? "fail" : "continues";
  return joinExclusive(thenPath, statementPath(statement.elseStatement, predicate));
}

function switchPath(
  statement: SwitchStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const completed: PathResult[] = [];
  let falling: PathResult | undefined;
  for (const clause of statement.caseBlock.clauses) {
    falling = takeSwitchClause(completed, falling, statementsPath(clause.statements, predicate));
  }
  if (falling !== undefined) completed.push(falling);
  if (!statement.caseBlock.clauses.some(isDefaultClause)) completed.push("continues");
  return joinAll(completed);
}

function takeSwitchClause(
  completed: PathResult[],
  falling: PathResult | undefined,
  local: PathResult,
): PathResult | undefined {
  const combined = falling === undefined ? local : joinFallthrough(falling, local);
  if (combined === "continues") return combined;
  completed.push(combined === "breaks" ? "continues" : combined);
  return undefined;
}

function tryPath(
  statement: TryStatement,
  predicate: (expression: Expression) => boolean,
): PathResult {
  const tryResult = statementsPath(statement.tryBlock.statements, predicate);
  const body = statement.catchClause
    ? joinExclusive(tryResult, statementsPath(statement.catchClause.block.statements, predicate))
    : tryResult;
  if (!statement.finallyBlock) return body;
  const finallyResult = statementsPath(statement.finallyBlock.statements, predicate);
  if (finallyResult === "fail") return "fail";
  if (finallyResult === "returns") return "returns";
  return body;
}

function joinFallthrough(incoming: PathResult, next: PathResult): PathResult {
  if (incoming === "fail" || next === "fail") return "fail";
  return next;
}

function joinExclusive(left: PathResult, right: PathResult): PathResult {
  if (left === "fail" || right === "fail") return "fail";
  if (left === "returns" && right === "returns") return "returns";
  if (left === "breaks" && right === "breaks") return "breaks";
  return "continues";
}

function joinAll(results: PathResult[]): PathResult {
  if (results.length === 0) return "continues";
  return results.reduce(joinExclusive);
}

function normalize(result: PathResult): PathResult {
  return result === "breaks" ? "continues" : result;
}
