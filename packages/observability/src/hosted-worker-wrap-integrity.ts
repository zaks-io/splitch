import {
  type ElementAccessExpression,
  forEachChild,
  isArrayBindingPattern,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isObjectBindingPattern,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { locationOf, unwrap } from "./hosted-worker-wrap-ast.js";
import type { ResolvedBinding } from "./hosted-worker-wrap-scope.js";

export type BindingIntegrity =
  | { readonly immutable: true }
  | { readonly immutable: false; readonly reason: string; readonly location: string };

type BindingResolver = (file: SourceFile, name: string, from: Node) => ResolvedBinding;

export function bindingIntegrity(
  file: SourceFile,
  binding: ResolvedBinding,
  resolveBinding: BindingResolver,
  allowedMethods: ReadonlySet<string> = new Set(["fetch"]),
): BindingIntegrity {
  if (!binding.declaration) {
    return { immutable: false, reason: "unresolved binding", location: `${file.fileName}:1:1` };
  }
  const declarations = aliasDeclarations(file, binding.declaration, resolveBinding);
  let failure: BindingIntegrity | undefined;
  const visit = (node: Node): void => {
    if (failure || isTypeNode(node)) return;
    failure = referenceMutation(file, node, declarations, resolveBinding, allowedMethods);
    if (!failure) forEachChild(node, visit);
  };
  visit(file);
  return failure ?? { immutable: true };
}

function referenceMutation(
  file: SourceFile,
  node: Node,
  declarations: ReadonlySet<Node>,
  resolveBinding: BindingResolver,
  allowedMethods: ReadonlySet<string>,
): BindingIntegrity | undefined {
  if (!isIdentifier(node)) return undefined;
  const resolved = resolveBinding(file, node.text, node);
  if (!resolved.declaration || !declarations.has(resolved.declaration)) return undefined;
  return mutationOfBindingReference(file, node, allowedMethods);
}

function aliasDeclarations(
  file: SourceFile,
  root: Node,
  resolveBinding: BindingResolver,
): Set<Node> {
  const declarations = new Set<Node>([root]);
  let added = true;
  while (added) {
    added = false;
    const visit = (node: Node): void => {
      const alias = aliasOfKnownBinding(file, node, declarations, resolveBinding);
      if (alias && !declarations.has(alias)) {
        declarations.add(alias);
        added = true;
      }
      forEachChild(node, visit);
    };
    visit(file);
  }
  return declarations;
}

function aliasOfKnownBinding(
  file: SourceFile,
  node: Node,
  declarations: ReadonlySet<Node>,
  resolveBinding: BindingResolver,
): Node | undefined {
  if (!isVariableDeclaration(node) || !isIdentifier(node.name) || !node.initializer) {
    return undefined;
  }
  const source = unwrap(node.initializer);
  if (!isIdentifier(source)) return undefined;
  const resolved = resolveBinding(file, source.text, source);
  return resolved.declaration && declarations.has(resolved.declaration) ? node : undefined;
}

function mutationOfBindingReference(
  file: SourceFile,
  reference: Node,
  allowedMethods: ReadonlySet<string>,
): BindingIntegrity | undefined {
  const assignment = containingAssignmentTarget(reference);
  if (assignment) return mutated(file, assignment, "wrapped handler binding is reassigned");
  const direct = directMutation(reference);
  if (direct) return mutated(file, direct.node, direct.reason);
  const call = containingCallArgument(reference);
  if (call) return mutated(file, call, "wrapped handler escapes to a potentially mutating call");
  return unsupportedMethodCall(file, reference, allowedMethods);
}

function directMutation(
  reference: Node,
): { readonly node: Node; readonly reason: string } | undefined {
  const accessed = outermostAccess(reference);
  if (isDeleteExpression(accessed.parent) && accessed.parent.expression === accessed) {
    return { node: accessed.parent, reason: "wrapped handler property is deleted" };
  }
  if (
    (isPrefixUnaryExpression(accessed.parent) || isPostfixUnaryExpression(accessed.parent)) &&
    accessed.parent.operand === accessed
  ) {
    return { node: accessed.parent, reason: "wrapped handler binding is updated" };
  }
  return undefined;
}

function unsupportedMethodCall(
  file: SourceFile,
  reference: Node,
  allowedMethods: ReadonlySet<string>,
): BindingIntegrity | undefined {
  const accessed = outermostAccess(reference);
  if (!isCallExpression(accessed.parent) || accessed.parent.expression !== accessed)
    return undefined;
  if (isIdentifier(accessed)) return undefined;
  if (isPropertyAccessExpression(accessed) && allowedMethods.has(accessed.name.text))
    return undefined;
  return mutated(file, accessed.parent, "wrapped handler uses an unsupported mutating call");
}

function containingAssignmentTarget(reference: Node): Node | undefined {
  let current: Node = reference;
  while (current.parent && isAssignmentContainer(current.parent)) {
    const parent = current.parent;
    const assignment = directAssignmentTarget(parent, reference);
    if (assignment) return assignment;
    current = parent;
  }
  return undefined;
}

function directAssignmentTarget(parent: Node, reference: Node): Node | undefined {
  if (isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
    return nodeContains(parent.left, reference) ? parent : undefined;
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) {
    return nodeContains(parent.initializer, reference) ? parent : undefined;
  }
  return undefined;
}

function isAssignmentContainer(node: Node): boolean {
  return (
    isAccessNode(node) ||
    isArrayBindingPattern(node) ||
    isObjectBindingPattern(node) ||
    isBinaryExpression(node) ||
    isForInStatement(node) ||
    isForOfStatement(node)
  );
}

function containingCallArgument(reference: Node): Node | undefined {
  let current: Node = reference;
  while (current.parent) {
    const parent = current.parent;
    if (isCallExpression(parent)) {
      return parent.arguments.some((argument) => nodeContains(argument, reference))
        ? parent
        : undefined;
    }
    if (isVariableDeclaration(parent) || isVariableStatement(parent) || isSourceFile(parent)) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

function outermostAccess(reference: Node): Node {
  let current = reference;
  while (current.parent && isAccessNode(current.parent) && current.parent.expression === current) {
    current = current.parent;
  }
  return current;
}

function isAccessNode(node: Node): node is PropertyAccessExpression | ElementAccessExpression {
  return isPropertyAccessExpression(node) || isElementAccessExpression(node);
}

function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

function nodeContains(container: Node, node: Node): boolean {
  return container.pos <= node.pos && node.end <= container.end;
}

function mutated(file: SourceFile, node: Node, reason: string): BindingIntegrity {
  return { immutable: false, reason, location: locationOf(file, node) };
}
