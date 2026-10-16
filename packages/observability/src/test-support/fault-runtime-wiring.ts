import ts from "typescript";
import { addBindingNames, propertyName, rejectionBindings } from "./fault-catch-bindings";
import { faultReportCalls } from "./fault-report-calls";

/** Engine frames are trusted only while application code cannot replace their source. */
export function unsafeStackWrites(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isStackTarget(node.left)
    )
      lines.push(lineOf(node, source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

function isStackTarget(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node)) return isStackTarget(node.expression);
  const field = propertyName(node);
  if (field === "stack") return true;
  return (
    field === "prepareStackTrace" &&
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isErrorConstructor(node.expression)
  );
}

function isErrorConstructor(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "Error";
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return isErrorConstructor(node.expression);
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    propertyName(node) === "Error" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "globalThis"
  );
}

/** A safe report must not be followed by handing the original rejection to Workers. */
export function reportedFaultRethrows(source: ts.SourceFile): number[] {
  const violations = new Set<number>();
  const reports = faultReportCalls(source);
  for (const [body, binding] of rejectionBindings(source)) {
    const caught = new Set<string>();
    addBindingNames(binding, caught);
    const nodes = handlerNodes(body);
    expandAliases(nodes, caught);
    inspectFlow(body, false, {
      caught,
      reports,
      flag: (node) => violations.add(lineOf(node, source)),
    });
  }
  return [...violations].sort((a, b) => a - b);
}

// Undefined means every path returned or threw, so later statements cannot leak that report.
type ReportFlow = boolean | undefined;

interface FlowContext {
  caught: Set<string>;
  reports: Set<ts.CallExpression>;
  flag: (node: ts.Node) => void;
}

function inspectFlow(node: ts.Node, reported: boolean, context: FlowContext): ReportFlow {
  if (ts.isBlock(node)) return inspectBlock(node.statements, reported, context);
  if (ts.isIfStatement(node)) {
    const before = reported || hasFaultReport(node.expression, context);
    const yes = inspectFlow(node.thenStatement, before, context);
    const no = node.elseStatement ? inspectFlow(node.elseStatement, before, context) : before;
    return mergeFlow(yes, no);
  }
  if (ts.isThrowStatement(node)) {
    if (reported && isCaught(node.expression, context.caught)) context.flag(node);
    return undefined;
  }
  if (ts.isReturnStatement(node)) return undefined;
  return inspectCompound(node, reported, context);
}

function inspectBlock(
  statements: ts.NodeArray<ts.Statement>,
  reported: boolean,
  context: FlowContext,
): ReportFlow {
  let state: ReportFlow = reported;
  for (const statement of statements) {
    if (state === undefined) break;
    state = inspectFlow(statement, state, context);
  }
  return state;
}

function inspectCompound(node: ts.Node, reported: boolean, context: FlowContext): ReportFlow {
  if (ts.isFunctionLike(node)) return reported;
  if (ts.isTryStatement(node)) {
    let state = inspectFlow(node.tryBlock, reported, context);
    // Nested rejection handlers are inspected with their own binding and report state.
    if (node.catchClause) state = mergeFlow(state, reported);
    if (node.finallyBlock) return inspectFlow(node.finallyBlock, state ?? reported, context);
    return state;
  }
  if (ts.isIterationStatement(node, false))
    return mergeFlow(reported, inspectFlow(node.statement, reported, context));
  return reported || hasFaultReport(node, context);
}

function mergeFlow(left: ReportFlow, right: ReportFlow): ReportFlow {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left || right;
}

function hasFaultReport(node: ts.Node, context: FlowContext): boolean {
  return handlerNodes(node).some(
    (child) => ts.isCallExpression(child) && context.reports.has(child),
  );
}

function handlerNodes(body: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  function collect(node: ts.Node): void {
    if (node !== body && (ts.isFunctionLike(node) || ts.isCatchClause(node))) return;
    nodes.push(node);
    ts.forEachChild(node, collect);
  }
  collect(body);
  return nodes;
}

function expandAliases(nodes: ts.Node[], caught: Set<string>): void {
  let previousSize = -1;
  while (previousSize !== caught.size) {
    previousSize = caught.size;
    nodes.forEach((node) => {
      addAlias(node, caught);
    });
  }
}

function addAlias(node: ts.Node, caught: Set<string>): void {
  if (ts.isVariableDeclaration(node) && node.initializer && isCaught(node.initializer, caught))
    addBindingNames(node.name, caught);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left) &&
    isCaught(node.right, caught)
  )
    caught.add(node.left.text);
}

function isCaught(node: ts.Node, caught: Set<string>): boolean {
  if (ts.isIdentifier(node)) return caught.has(node.text);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
    return isCaught(node.expression, caught);
  return false;
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
