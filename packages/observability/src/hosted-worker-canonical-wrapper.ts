import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  type SourceFile,
} from "typescript";
import { unwrap } from "./hosted-worker-wrap-ast.js";
import { resolveName } from "./hosted-worker-wrap-scope.js";

export function isCanonicalWrapperCall(file: SourceFile, expression: Expression): boolean {
  const call = unwrap(expression);
  if (!isCallExpression(call) || call.arguments.length < 1 || call.arguments.length > 2)
    return false;
  if (!isDirectOfficialWrapperCallee(file, call.expression)) return false;
  const handler = call.arguments[0];
  if (!handler || !isCanonicalHandler(handler)) return false;
  const options = call.arguments[1];
  return options === undefined || isCanonicalOptions(options);
}

function isCanonicalHandler(expression: Expression): boolean {
  const handler = unwrap(expression);
  if (isIdentifier(handler)) return true;
  if (!isObjectLiteralExpression(handler)) return false;
  let fetches = 0;
  for (const property of handler.properties) {
    if (isSpreadAssignment(property) || !property.name || !isIdentifier(property.name))
      return false;
    if (property.name.text === "fetch") fetches += 1;
  }
  return fetches === 1;
}

function isCanonicalOptions(expression: Expression): boolean {
  const options = unwrap(expression);
  return (
    isObjectLiteralExpression(options) &&
    options.properties.every(
      (property) =>
        isPropertyAssignment(property) &&
        isIdentifier(property.name) &&
        isStringLiteral(unwrap(property.initializer)),
    )
  );
}

function isDirectOfficialWrapperCallee(file: SourceFile, expression: Expression): boolean {
  const callee = unwrap(expression);
  if (isIdentifier(callee)) return resolveName(file, callee.text, callee).kind === "official-wrap";
  if (!isPropertyAccessExpression(callee) || callee.name.text !== "wrapWorkerHandler") return false;
  const target = unwrap(callee.expression);
  return (
    isIdentifier(target) && resolveName(file, target.text, target).kind === "official-namespace"
  );
}
