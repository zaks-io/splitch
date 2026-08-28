import {
  type ElementAccessExpression,
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLike,
  isIdentifier,
  isParameter,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { unwrap } from "./hosted-worker-wrap-ast.js";
import type { ResolvedBinding } from "./hosted-worker-wrap-scope.js";

type BindingResolver = (file: SourceFile, name: string, from: Node) => ResolvedBinding;

export function expressionAliasesKnownBinding(
  file: SourceFile,
  expression: Expression,
  declarations: ReadonlySet<Node>,
  resolveBinding: BindingResolver,
): boolean {
  const source = unwrap(expression);
  if (isIdentifier(source)) {
    const resolved = resolveBinding(file, source.text, source);
    return Boolean(resolved.declaration && declarations.has(resolved.declaration));
  }
  if (isConditionalExpression(source)) {
    return (
      expressionAliasesKnownBinding(file, source.whenTrue, declarations, resolveBinding) &&
      expressionAliasesKnownBinding(file, source.whenFalse, declarations, resolveBinding)
    );
  }
  return (
    isBinaryExpression(source) &&
    source.operatorToken.kind === SyntaxKind.CommaToken &&
    expressionAliasesKnownBinding(file, source.right, declarations, resolveBinding)
  );
}

export function unsupportedValueFlow(
  reference: Node,
  declarations: ReadonlySet<Node>,
): Node | undefined {
  let current = reference;
  while (current.parent) {
    const parent = current.parent;
    const step = valueFlowStep(parent, current, declarations);
    if (step === "safe") return undefined;
    if (step !== "continue") return step.escape;
    current = parent;
  }
  return undefined;
}

type ValueFlowStep = "continue" | "safe" | { readonly escape: Node };

function valueFlowStep(parent: Node, child: Node, declarations: ReadonlySet<Node>): ValueFlowStep {
  if (isAccessNode(parent) && parent.expression === child) return "safe";
  const boundary = valueFlowBoundary(parent, child, declarations);
  if (boundary) return boundary;
  if (valueFlowsThrough(parent, child)) return "continue";
  return isUnsupportedValueCarrier(parent, child) ? { escape: parent } : "safe";
}

function valueFlowBoundary(
  parent: Node,
  child: Node,
  declarations: ReadonlySet<Node>,
): ValueFlowStep | undefined {
  if (isVariableDeclaration(parent) && parent.initializer === child) {
    return declarations.has(parent) ? "safe" : { escape: parent };
  }
  if (isExportAssignment(parent) && parent.expression === child) return "safe";
  if (isReturnStatement(parent) && parent.expression === child) {
    return helperReturnBoundary(enclosingFunction(parent), declarations, parent);
  }
  if (isArrowFunction(parent) && parent.body === child) {
    return helperReturnBoundary(parent, declarations, parent);
  }
  return undefined;
}

function helperReturnBoundary(
  fn: Node | undefined,
  declarations: ReadonlySet<Node>,
  escapeNode: Node,
): ValueFlowStep {
  return isParameterDerived(declarations) || isDirectDefaultExportFunction(fn)
    ? "safe"
    : { escape: escapeNode };
}

function isParameterDerived(declarations: ReadonlySet<Node>): boolean {
  return [...declarations].some(isParameter);
}

function isUnsupportedValueCarrier(parent: Node, child: Node): boolean {
  if (!isBinaryExpression(parent) || (parent.left !== child && parent.right !== child))
    return false;
  return (
    parent.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken ||
    parent.operatorToken.kind === SyntaxKind.BarBarToken ||
    parent.operatorToken.kind === SyntaxKind.QuestionQuestionToken
  );
}

function valueFlowsThrough(parent: Node, child: Node): boolean {
  if (isExpression(parent) && unwrap(parent) !== parent) return true;
  if (isConditionalExpression(parent)) {
    return parent.whenTrue === child || parent.whenFalse === child;
  }
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.CommaToken &&
    parent.right === child
  );
}

function enclosingFunction(node: Node): Node | undefined {
  let current = node.parent;
  while (current && !isFunctionLike(current)) current = current.parent;
  return current;
}

function isDirectDefaultExportFunction(node: Node | undefined): boolean {
  if (!node) return false;
  if (isFunctionDeclaration(node)) {
    return Boolean(
      node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) &&
        node.modifiers.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword),
    );
  }
  return (
    (isArrowFunction(node) || isFunctionExpression(node)) &&
    isExportAssignment(node.parent) &&
    node.parent.expression === node
  );
}

function isAccessNode(node: Node): node is PropertyAccessExpression | ElementAccessExpression {
  return isPropertyAccessExpression(node) || isElementAccessExpression(node);
}
