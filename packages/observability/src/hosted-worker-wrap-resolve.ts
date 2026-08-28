import {
  type ArrowFunction,
  type CallExpression,
  type ConditionalExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
  type SourceFile,
} from "typescript";
import { blockPath, fail, type PathResult, RETURNS, unwrap } from "./hosted-worker-wrap-ast.js";
import {
  denotesOfficialNamespace,
  denotesOfficialWrap,
  resolveName,
  WRAP_WORKER_HANDLER,
} from "./hosted-worker-wrap-scope.js";

export { WRAP_WORKER_HANDLER };

function expressionIsWrap(
  file: SourceFile,
  expression: Expression,
  seen: ReadonlySet<string>,
): boolean {
  return expressionWrapPath(file, expression, seen).kind === "returns";
}

export function expressionWrapPath(
  file: SourceFile,
  expression: Expression,
  seen: ReadonlySet<string>,
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
  seen: ReadonlySet<string>,
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
  return isIdentifier(target) ? identifierIsWrap(file, target.text, new Set(), target) : false;
}

function bothBranchesWrap(
  file: SourceFile,
  value: ConditionalExpression,
  seen: ReadonlySet<string>,
): PathResult {
  const whenTrue = requireWrapped(file, value.whenTrue, seen);
  if (whenTrue.kind !== "returns") return whenTrue;
  return requireWrapped(file, value.whenFalse, seen);
}

function requireWrapped(
  file: SourceFile,
  expression: Expression,
  seen: ReadonlySet<string>,
): PathResult {
  const path = expressionWrapPath(file, expression, seen);
  return path.kind === "returns" || path.kind === "fail"
    ? path
    : fail(file, expression, "unwrapped response path");
}

function callWrapPath(
  file: SourceFile,
  value: CallExpression,
  seen: ReadonlySet<string>,
): PathResult {
  if (isOfficialWrapCall(file, value)) return RETURNS;
  const callee = unwrap(value.expression);
  if (isIdentifier(callee)) return identifierWrapPath(file, callee.text, seen, callee);
  return fail(file, value, "unwrapped response path");
}

function identifierWrapPath(
  file: SourceFile,
  name: string,
  seen: ReadonlySet<string>,
  node: Node,
): PathResult {
  const binding = resolveName(file, name, node);
  if (binding.kind === "official-wrap" || binding.kind === "official-namespace") {
    return fail(file, node, "wrapWorkerHandler itself is not a wrapped handler");
  }
  if (seen.has(name)) return fail(file, node, "circular wrap alias");
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  if (binding.kind !== "value") return fail(file, node, `unresolved identifier ${name}`);
  if (isFunctionDeclaration(binding.value)) return functionWrapPath(file, binding.value, nextSeen);
  return expressionWrapPath(file, binding.value, nextSeen);
}

function identifierIsWrap(
  file: SourceFile,
  name: string,
  seen: ReadonlySet<string>,
  node: Node,
): boolean {
  return identifierWrapPath(file, name, seen, node).kind === "returns";
}

function isOfficialWrapCall(file: SourceFile, expression: Expression): boolean {
  const value = unwrap(expression);
  if (!isCallExpression(value)) return false;
  const callee = unwrap(value.expression);
  if (isIdentifier(callee)) return denotesOfficialWrap(file, callee, new Set());
  if (
    isPropertyAccessExpression(callee) &&
    isIdentifier(callee.name) &&
    callee.name.text === WRAP_WORKER_HANDLER
  ) {
    const object = unwrap(callee.expression);
    return isIdentifier(object) && denotesOfficialNamespace(file, object, new Set());
  }
  return false;
}
