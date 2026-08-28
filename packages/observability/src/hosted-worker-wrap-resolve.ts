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
import { bindingIntegrity } from "./hosted-worker-wrap-integrity.js";
import {
  denotesOfficialNamespace,
  denotesOfficialWrap,
  type ResolvedBinding,
  resolveName,
  WRAP_WORKER_HANDLER,
} from "./hosted-worker-wrap-scope.js";

export { WRAP_WORKER_HANDLER };

type CallBindings = ReadonlyMap<Node, Expression>;

function expressionIsWrap(
  file: SourceFile,
  expression: Expression,
  seen: ReadonlySet<Node>,
  callBindings: CallBindings = new Map(),
): boolean {
  return expressionWrapPath(file, expression, seen, callBindings).kind === "returns";
}

export function expressionWrapPath(
  file: SourceFile,
  expression: Expression,
  seen: ReadonlySet<Node>,
  callBindings: CallBindings = new Map(),
): PathResult {
  const value = unwrap(expression);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return functionWrapPath(file, value, seen, callBindings);
  }
  if (isConditionalExpression(value)) return bothBranchesWrap(file, value, seen, callBindings);
  if (isCallExpression(value)) return callWrapPath(file, value, seen, callBindings);
  if (isIdentifier(value)) {
    return identifierWrapPath(file, value.text, seen, value, callBindings);
  }
  return fail(file, value, "default export is not the official wrapWorkerHandler binding");
}

export function functionWrapPath(
  file: SourceFile,
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  seen: ReadonlySet<Node>,
  callBindings: CallBindings = new Map(),
): PathResult {
  if (!fn.body) return fail(file, fn, "function has no body");
  if (!isBlock(fn.body)) return expressionWrapPath(file, fn.body, seen, callBindings);
  const path = blockPath(file, fn.body, (expression) =>
    expressionIsWrap(file, expression, seen, callBindings),
  );
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
  seen: ReadonlySet<Node>,
  callBindings: CallBindings,
): PathResult {
  const whenTrue = requireWrapped(file, value.whenTrue, seen, callBindings);
  if (whenTrue.kind !== "returns") return whenTrue;
  return requireWrapped(file, value.whenFalse, seen, callBindings);
}

function requireWrapped(
  file: SourceFile,
  expression: Expression,
  seen: ReadonlySet<Node>,
  callBindings: CallBindings,
): PathResult {
  const path = expressionWrapPath(file, expression, seen, callBindings);
  return path.kind === "returns" || path.kind === "fail"
    ? path
    : fail(file, expression, "unwrapped response path");
}

function callWrapPath(
  file: SourceFile,
  value: CallExpression,
  seen: ReadonlySet<Node>,
  callBindings: CallBindings,
): PathResult {
  if (isOfficialWrapCall(file, value)) return RETURNS;
  const callee = unwrap(value.expression);
  if (isIdentifier(callee)) {
    const target = invokedFunction(file, callee);
    if (target) return invokedFunctionWrapPath(file, target, value.arguments, seen, callBindings);
    return identifierWrapPath(file, callee.text, seen, callee, callBindings);
  }
  return fail(file, value, "unwrapped response path");
}

function invokedFunction(
  file: SourceFile,
  callee: Node,
): FunctionDeclaration | ArrowFunction | FunctionExpression | undefined {
  if (!isIdentifier(callee)) return undefined;
  const binding = resolveName(file, callee.text, callee);
  if (binding.kind !== "value") return undefined;
  if (!bindingIntegrity(file, binding, resolveName, new Set()).immutable) return undefined;
  const target = isFunctionDeclaration(binding.value) ? binding.value : unwrap(binding.value);
  return isFunctionDeclaration(target) || isArrowFunction(target) || isFunctionExpression(target)
    ? target
    : undefined;
}

function invokedFunctionWrapPath(
  file: SourceFile,
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  args: readonly Expression[],
  seen: ReadonlySet<Node>,
  callBindings: CallBindings,
): PathResult {
  const supplied = new Map(callBindings);
  for (const [index, parameter] of fn.parameters.entries()) {
    const argument = args[index];
    if (argument) supplied.set(parameter, argument);
  }
  return functionWrapPath(file, fn, seen, supplied);
}

function identifierWrapPath(
  file: SourceFile,
  name: string,
  seen: ReadonlySet<Node>,
  node: Node,
  callBindings: CallBindings,
): PathResult {
  const binding = resolveName(file, name, node);
  const invalid = invalidBindingPath(file, binding, name, node, seen);
  if (invalid) return invalid;
  if (!binding.declaration) return fail(file, node, `unresolved identifier ${name}`);
  const supplied = callBindings.get(binding.declaration);
  if (supplied) return expressionWrapPath(file, supplied, seen, callBindings);
  const nextSeen = new Set(seen);
  nextSeen.add(binding.declaration);
  if (binding.kind !== "value") return fail(file, node, `unresolved identifier ${name}`);
  if (isFunctionDeclaration(binding.value)) {
    return functionWrapPath(file, binding.value, nextSeen, callBindings);
  }
  return expressionWrapPath(file, binding.value, nextSeen, callBindings);
}

function invalidBindingPath(
  file: SourceFile,
  binding: ResolvedBinding,
  name: string,
  node: Node,
  seen: ReadonlySet<Node>,
): PathResult | undefined {
  if (binding.kind === "official-wrap" || binding.kind === "official-namespace") {
    return fail(file, node, "wrapWorkerHandler itself is not a wrapped handler");
  }
  if (!binding.declaration) return fail(file, node, `unresolved identifier ${name}`);
  if (seen.has(binding.declaration)) return fail(file, node, "circular wrap alias");
  const integrity = bindingIntegrity(file, binding, resolveName);
  return integrity.immutable
    ? undefined
    : { kind: "fail", reason: integrity.reason, location: integrity.location };
}

function identifierIsWrap(
  file: SourceFile,
  name: string,
  seen: ReadonlySet<Node>,
  node: Node,
): boolean {
  return identifierWrapPath(file, name, seen, node, new Map()).kind === "returns";
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
