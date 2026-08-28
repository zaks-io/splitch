import {
  type CallExpression,
  forEachChild,
  isCallExpression,
  isExportAssignment,
  isIdentifier,
  isImportSpecifier,
  isNewExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { resolveName } from "./hosted-worker-wrap-scope.js";

export function canonicalSourceFailure(file: SourceFile): Node | undefined {
  return unsafeDynamicSyntax(file) ?? nonCanonicalOfficialWrapperUse(file);
}

function nonCanonicalOfficialWrapperUse(file: SourceFile): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found) return;
    if (isNonCanonicalOfficialWrapperUse(file, node)) found = node;
    forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function isNonCanonicalOfficialWrapperUse(file: SourceFile, node: Node): boolean {
  if (isIdentifier(node) && resolveName(file, node.text, node).kind === "official-wrap") {
    return !isImportSpecifier(node.parent) && !isCanonicalWrapperReference(node);
  }
  return isOfficialNamespaceWrapper(file, node) && !isCanonicalWrapperReference(node);
}

function isOfficialNamespaceWrapper(file: SourceFile, node: Node): boolean {
  if (!isPropertyAccessExpression(node) || node.name.text !== "wrapWorkerHandler") return false;
  const target = node.expression;
  return (
    isIdentifier(target) && resolveName(file, target.text, target).kind === "official-namespace"
  );
}

function isCanonicalWrapperReference(reference: Node): boolean {
  const call = reference.parent;
  if (!isCallExpression(call) || call.expression !== reference) return false;
  return isCanonicalWrapperCallParent(call);
}

function isCanonicalWrapperCallParent(call: CallExpression): boolean {
  if (isExportAssignment(call.parent) && call.parent.expression === call) return true;
  const access = call.parent;
  if (
    !isPropertyAccessExpression(access) ||
    access.expression !== call ||
    access.name.text !== "fetch"
  )
    return false;
  const outerCall = access.parent;
  return (
    isCallExpression(outerCall) &&
    outerCall.expression === access &&
    isReturnStatement(outerCall.parent) &&
    outerCall.parent.expression === outerCall
  );
}

function unsafeDynamicSyntax(file: SourceFile): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found) return;
    if (
      (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) ||
      ((isCallExpression(node) || isNewExpression(node)) &&
        isIdentifier(node.expression) &&
        (node.expression.text === "eval" || node.expression.text === "Function"))
    ) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  };
  visit(file);
  return found;
}
