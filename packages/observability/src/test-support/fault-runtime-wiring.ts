import ts from "typescript";
import { addBindingNames, propertyName, rejectionBindings } from "./fault-catch-bindings";
import { faultReportCalls } from "./fault-report-calls";

const fixedResultOperators = new Set([
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Report-then-rethrow tripwire for catch/rejection callbacks: throw and Promise.reject,
 * caught aliases/properties, operator outputs, derived Error messages and cause options.
 * Fresh static or fault-code Errors remain allowed. Deliberate evasion is outside scope.
 */
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
  if (ts.isIfStatement(node)) return inspectBranch(node, reported, context);
  if (ts.isThrowStatement(node)) {
    if (reported && isCaught(node.expression, context.caught)) context.flag(node);
    return undefined;
  }
  if (reported) flagRejectedTaint(node, context);
  if (ts.isReturnStatement(node)) return undefined;
  return inspectCompound(node, reported, context);
}

function inspectBranch(node: ts.IfStatement, reported: boolean, context: FlowContext): ReportFlow {
  const before = reported || hasFaultReport(node.expression, context);
  const yes = inspectFlow(node.thenStatement, before, context);
  const no = node.elseStatement ? inspectFlow(node.elseStatement, before, context) : before;
  return mergeFlow(yes, no);
}

function flagRejectedTaint(node: ts.Node, context: FlowContext): void {
  for (const child of handlerNodes(node))
    if (isPromiseReject(child) && child.arguments.some((arg) => isCaught(arg, context.caught)))
      context.flag(child);
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
  if (ts.isFunctionLike(node)) return false;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return isCaught(node.expression, caught);
  if (ts.isPropertyAssignment(node)) return isCaught(node.initializer, caught);
  return emittedChildren(node).some((child) => isCaught(child, caught));
}

/** Value taint follows operator results, not the data used to choose those results. */
function emittedChildren(node: ts.Node): ts.Node[] {
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
  if (ts.isTypeOfExpression(node)) return [];
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
    return [];
  if (ts.isBinaryExpression(node)) return binaryValues(node);
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

function binaryValues(node: ts.BinaryExpression): ts.Node[] {
  const operator = node.operatorToken.kind;
  if (fixedResultOperators.has(operator)) return [];
  // The left side of && can reach the result only as a falsy value, which carries no data.
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return [node.right];
  // Both operands can contribute data to ||, ?? and the remaining value operators.
  return [node.left, node.right];
}

function isPromiseReject(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    propertyName(node.expression) === "reject" &&
    (ts.isPropertyAccessExpression(node.expression) ||
      ts.isElementAccessExpression(node.expression)) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Promise"
  );
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
