import {
  forEachChild,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isIdentifier,
  isImportSpecifier,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
  type ClassElement,
  type ClassLikeDeclaration,
  type MethodDeclaration,
  type Node,
  SyntaxKind,
} from "typescript";

const STATIC = SyntaxKind.StaticKeyword;

export function unsupportedClassMember(declaration: ClassLikeDeclaration): Node | undefined {
  for (const member of declaration.members) {
    if (isUnsupportedMember(member)) return member;
    const unsafe = unsafeNonFetchMethodSyntax(member);
    if (unsafe) return unsafe;
  }
  return undefined;
}

function isUnsupportedMember(member: ClassElement): boolean {
  if (isConstructorDeclaration(member) || isClassStaticBlockDeclaration(member)) return true;
  if (!isMethodDeclaration(member) || !isIdentifier(member.name)) return true;
  if (hasModifier(member, STATIC) || hasModifier(member, SyntaxKind.Decorator)) return true;
  return member.name.text !== "fetch" && !hasSingleReturn(member);
}

function unsafeNonFetchMethodSyntax(member: ClassElement): Node | undefined {
  if (!isMethodDeclaration(member) || !isIdentifier(member.name) || member.name.text === "fetch") {
    return undefined;
  }
  return unsafeFetchMutationSyntax(member);
}

function hasSingleReturn(method: MethodDeclaration): boolean {
  if (method.body?.statements.length !== 1) return false;
  const statement = method.body.statements[0];
  return Boolean(statement && isReturnStatement(statement) && statement.expression);
}

function unsafeFetchMutationSyntax(root: Node): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found) return;
    if (isUnsafeFetchSyntax(node)) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return found;
}

function isUnsafeFetchSyntax(node: Node): boolean {
  if (isElementAccessExpression(node) && node.expression.kind === SyntaxKind.ThisKeyword)
    return true;
  if (isUnsafeThisReference(node)) return true;
  if (isIdentifier(node)) {
    return ["constructor", "eval", "fetch", "prototype"].includes(node.text);
  }
  return isStringLiteral(node) && node.text === "fetch" && !isImportSpecifier(node.parent);
}

function isUnsafeThisReference(node: Node): boolean {
  if (node.kind !== SyntaxKind.ThisKeyword) return false;
  return !isPropertyAccessExpression(node.parent) || node.parent.expression !== node;
}

function hasModifier(
  node: { readonly modifiers?: readonly { readonly kind: SyntaxKind }[] },
  kind: SyntaxKind,
): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}
