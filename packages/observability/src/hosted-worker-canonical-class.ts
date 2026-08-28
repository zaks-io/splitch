import {
  type ClassLikeDeclaration,
  type Expression,
  forEachChild,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isIdentifier,
  isImportSpecifier,
  isMethodDeclaration,
  isParameter,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  NodeFlags,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
} from "typescript";
import { unsupportedClassMember } from "./hosted-worker-canonical-class-members.js";
import { canonicalFailure, type CanonicalProof } from "./hosted-worker-canonical-proof.js";
import { canonicalSourceFailure } from "./hosted-worker-canonical-source.js";
import { isCanonicalWrapperCall } from "./hosted-worker-canonical-wrapper.js";
import { isFetchPropertyName } from "./hosted-worker-entrypoints.js";
import { unwrap } from "./hosted-worker-wrap-ast.js";
import { resolveName } from "./hosted-worker-wrap-scope.js";

const STATIC = SyntaxKind.StaticKeyword;

export function canonicalClassProof(
  file: SourceFile,
  declaration: ClassLikeDeclaration,
): CanonicalProof {
  const unsafe = canonicalSourceFailure(file);
  if (unsafe) return canonicalFailure(file, unsafe, "non-canonical dynamic or wrapper syntax");
  const structureFailure = canonicalClassStructureFailure(file, declaration);
  if (structureFailure) return structureFailure;
  return canonicalFetchProof(file, declaration);
}

function canonicalClassStructureFailure(
  file: SourceFile,
  declaration: ClassLikeDeclaration,
): CanonicalProof | undefined {
  const shellFailure = unsupportedClassShell(declaration);
  if (shellFailure)
    return canonicalFailure(file, shellFailure, "unsupported WorkerEntrypoint class syntax");
  const exportFailure = canonicalClassExportFailure(declaration);
  if (exportFailure)
    return canonicalFailure(file, exportFailure, "WorkerEntrypoint class export is not canonical");
  if (!extendsDirectWorkerEntrypoint(file, declaration)) {
    return canonicalFailure(
      file,
      declaration,
      "class must directly extend the official WorkerEntrypoint",
    );
  }
  const externalUse = classBindingUseOutsideDeclaration(file, declaration);
  if (externalUse) {
    return canonicalFailure(
      file,
      externalUse,
      "WorkerEntrypoint class binding is used outside its export",
    );
  }
  const memberFailure = unsupportedClassMember(declaration);
  return memberFailure
    ? canonicalFailure(file, memberFailure, "unsupported WorkerEntrypoint class member")
    : undefined;
}

function unsupportedClassShell(declaration: ClassLikeDeclaration): Node | undefined {
  if (declaration.typeParameters?.length) return declaration.typeParameters[0];
  if (declaration.heritageClauses?.length !== 1) return declaration;
  if (hasModifier(declaration, SyntaxKind.Decorator)) return declaration;
  return undefined;
}

function canonicalFetchProof(file: SourceFile, declaration: ClassLikeDeclaration): CanonicalProof {
  const fetches = declaration.members.filter(
    (member): member is MethodDeclaration =>
      isMethodDeclaration(member) && isFetchPropertyName(member.name),
  );
  if (fetches.length !== 1) {
    return canonicalFailure(
      file,
      fetches[1] ?? declaration,
      "class must define exactly one instance fetch",
    );
  }
  const fetch = fetches[0];
  if (!fetch) return canonicalFailure(file, declaration, "class must define one instance fetch");
  const expression = canonicalFetchExpression(fetch);
  if (!expression) return canonicalFailure(file, fetch, "fetch method is not canonical");
  return isCanonicalWrappedFetch(file, expression, fetch.parameters)
    ? { wrapped: true }
    : canonicalFailure(file, expression, "fetch must return the direct official wrapper response");
}

function canonicalFetchExpression(fetch: MethodDeclaration): Expression | undefined {
  if (hasModifier(fetch, STATIC) || !isIdentifier(fetch.name) || fetch.name.text !== "fetch") {
    return undefined;
  }
  if (unsupportedFetchSignature(fetch) || fetch.body?.statements.length !== 1) return undefined;
  const returned = fetch.body.statements[0];
  return returned && isReturnStatement(returned) ? returned.expression : undefined;
}

function unsupportedFetchSignature(fetch: MethodDeclaration): boolean {
  const parameter = fetch.parameters[0];
  return Boolean(
    fetch.asteriskToken ||
      fetch.questionToken ||
      fetch.typeParameters?.length ||
      !parameter ||
      parameter.initializer ||
      parameter.dotDotDotToken ||
      parameter.questionToken ||
      parameter.modifiers?.length ||
      hasModifier(fetch, SyntaxKind.Decorator),
  );
}

function canonicalClassExportFailure(declaration: ClassLikeDeclaration): Node | undefined {
  if (isClassDeclaration(declaration)) return classDeclarationExportFailure(declaration);
  return classExpressionExportFailure(declaration);
}

function classDeclarationExportFailure(declaration: ClassLikeDeclaration): Node | undefined {
  if (!declaration.name && !isDefaultExport(declaration)) return declaration;
  return hasModifier(declaration, SyntaxKind.ExportKeyword) ? undefined : declaration;
}

function classExpressionExportFailure(declaration: ClassLikeDeclaration): Node | undefined {
  if (!isClassExpression(declaration) || declaration.name) return declaration;
  const variable = declaration.parent;
  if (!isVariableDeclaration(variable) || variable.initializer !== declaration) return declaration;
  const list = variable.parent;
  const statement = list.parent;
  if (!isVariableDeclarationList(list) || !isVariableStatement(statement)) return declaration;
  return (list.flags & NodeFlags.Const) !== 0 && hasModifier(statement, SyntaxKind.ExportKeyword)
    ? undefined
    : statement;
}

function isCanonicalWrappedFetch(
  file: SourceFile,
  expression: Expression,
  parameters: readonly ParameterDeclaration[],
): boolean {
  const call = unwrap(expression);
  if (!isCallExpression(call) || call.arguments.length !== 3) return false;
  const callee = unwrap(call.expression);
  if (!isPropertyAccessExpression(callee) || callee.name.text !== "fetch") return false;
  if (!isCanonicalWrapperCall(file, callee.expression)) return false;
  return hasCanonicalFetchArguments(call.arguments, parameters);
}

function hasCanonicalFetchArguments(
  args: readonly Expression[],
  parameters: readonly ParameterDeclaration[],
): boolean {
  const candidate = parameters[0];
  const parameter =
    parameters.length === 1 && candidate && isParameter(candidate) ? candidate : undefined;
  if (!parameter || !isIdentifier(parameter.name)) return false;
  const [requestArgument, envArgument, ctxArgument] = args;
  if (!requestArgument || !envArgument || !ctxArgument) return false;
  const request = unwrap(requestArgument);
  return (
    isIdentifier(request) &&
    request.text === parameter.name.text &&
    isThisProperty(envArgument, "env") &&
    isThisProperty(ctxArgument, "ctx")
  );
}

function isThisProperty(expression: Expression, name: string): boolean {
  const value = unwrap(expression);
  return (
    isPropertyAccessExpression(value) &&
    value.expression.kind === SyntaxKind.ThisKeyword &&
    value.name.text === name
  );
}

function classBindingUseOutsideDeclaration(
  file: SourceFile,
  declaration: ClassLikeDeclaration,
): Node | undefined {
  const binding = isClassDeclaration(declaration) ? declaration : declaration.parent;
  const name = isClassDeclaration(declaration) ? declaration.name?.text : variableName(binding);
  const declarationName = isClassDeclaration(declaration)
    ? declaration.name
    : isVariableDeclaration(binding) && isIdentifier(binding.name)
      ? binding.name
      : undefined;
  if (!name) return undefined;
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found) return;
    if (isIdentifier(node) && node.text === name && node !== declarationName) {
      const resolved = resolveName(file, name, node);
      if (resolved.declaration === binding) found = node;
    }
    forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function variableName(node: Node): string | undefined {
  return isVariableDeclaration(node) && isIdentifier(node.name) ? node.name.text : undefined;
}

function extendsDirectWorkerEntrypoint(
  file: SourceFile,
  declaration: ClassLikeDeclaration,
): boolean {
  const bases = declaration.heritageClauses?.flatMap((clause) =>
    clause.token === SyntaxKind.ExtendsKeyword ? [...clause.types] : [],
  );
  if (bases?.length !== 1) return false;
  const base = bases[0];
  if (!base) return false;
  const expression = unwrap(base.expression);
  if (!isIdentifier(expression)) return false;
  const binding = resolveName(file, expression.text, expression);
  const imported = binding.declaration;
  return (
    binding.kind === "unresolved" &&
    imported !== undefined &&
    isImportSpecifier(imported) &&
    (imported.propertyName ?? imported.name).text === "WorkerEntrypoint" &&
    isStringLiteral(imported.parent.parent.parent.moduleSpecifier) &&
    imported.parent.parent.parent.moduleSpecifier.text === "cloudflare:workers"
  );
}

function isDefaultExport(node: ClassLikeDeclaration): boolean {
  return (
    hasModifier(node, SyntaxKind.ExportKeyword) && hasModifier(node, SyntaxKind.DefaultKeyword)
  );
}

function hasModifier(
  node: { readonly modifiers?: readonly { readonly kind: SyntaxKind }[] },
  kind: SyntaxKind,
): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}
