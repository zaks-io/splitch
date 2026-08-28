import {
  type ArrowFunction,
  type BindingName,
  type Block,
  type Expression,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type FunctionDeclaration,
  type FunctionExpression,
  forEachChild,
  isArrayBindingPattern,
  isArrowFunction,
  isBindingElement,
  isBlock,
  isCatchClause,
  isClassDeclaration,
  isConstructorDeclaration,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedImports,
  isNamespaceImport,
  isObjectBindingPattern,
  isOmittedExpression,
  isSourceFile,
  isStringLiteral,
  isVariableDeclarationList,
  isVariableStatement,
  type NamedImports,
  type Node,
  NodeFlags,
  type ParameterDeclaration,
  type SourceFile,
  type Statement,
  type VariableDeclarationList,
} from "typescript";
import { unwrap } from "./hosted-worker-wrap-ast.js";

export const WRAP_WORKER_HANDLER = "wrapWorkerHandler";

const OFFICIAL_WRAP_WORKER_HANDLER_SPECIFIERS = [
  "@splitch/worker-runtime",
  "@splitch/observability/worker",
] as const;

type ResolvedBinding =
  | { readonly kind: "official-wrap" }
  | { readonly kind: "official-namespace" }
  | { readonly kind: "value"; readonly value: Expression | FunctionDeclaration }
  | { readonly kind: "unresolved" };

export function resolveName(file: SourceFile, name: string, from: Node): ResolvedBinding {
  let current: Node | undefined = from.parent;
  while (current && !isSourceFile(current)) {
    const binding = bindingInScope(current, name);
    if (binding) return binding;
    current = current.parent;
  }
  return moduleBinding(file, name);
}

export function denotesOfficialWrap(
  file: SourceFile,
  node: Node,
  seen: ReadonlySet<string>,
): boolean {
  return denotesOfficialKind(file, node, seen, "official-wrap");
}

export function denotesOfficialNamespace(
  file: SourceFile,
  node: Node,
  seen: ReadonlySet<string>,
): boolean {
  return denotesOfficialKind(file, node, seen, "official-namespace");
}

function denotesOfficialKind(
  file: SourceFile,
  node: Node,
  seen: ReadonlySet<string>,
  kind: "official-wrap" | "official-namespace",
): boolean {
  if (!isIdentifier(node) || seen.has(node.text)) return false;
  const binding = resolveName(file, node.text, node);
  if (binding.kind === kind) return true;
  if (binding.kind !== "value") return false;
  const value = isFunctionDeclaration(binding.value) ? undefined : unwrap(binding.value);
  if (!value || !isIdentifier(value)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(node.text);
  return denotesOfficialKind(file, value, nextSeen, kind);
}

function bindingInScope(scope: Node, name: string): ResolvedBinding | undefined {
  if (isFunctionDeclaration(scope) || isFunctionExpression(scope) || isArrowFunction(scope)) {
    return functionLikeBinding(scope, name);
  }
  if (isMethodDeclaration(scope) || isConstructorDeclaration(scope)) {
    return parameterBinding(scope.parameters, name);
  }
  if (isBlock(scope)) return blockBinding(scope, name);
  if (isForStatement(scope) || isForInStatement(scope) || isForOfStatement(scope)) {
    return forBinding(scope, name);
  }
  return catchBinding(scope, name);
}

function functionLikeBinding(
  fn: FunctionDeclaration | FunctionExpression | ArrowFunction,
  name: string,
): ResolvedBinding | undefined {
  if (fn.name && isIdentifier(fn.name) && fn.name.text === name) {
    return { kind: "value", value: fn };
  }
  const parameter = parameterBinding(fn.parameters, name);
  if (parameter) return parameter;
  if (fn.body && isBlock(fn.body)) {
    const hoisted = hoistedVarBinding(fn.body, name);
    if (hoisted) return hoisted;
  }
  return undefined;
}

function parameterBinding(
  parameters: readonly ParameterDeclaration[],
  name: string,
): ResolvedBinding | undefined {
  for (const parameter of parameters) {
    if (bindingNameHas(parameter.name, name)) {
      return parameter.initializer
        ? { kind: "value", value: parameter.initializer }
        : { kind: "unresolved" };
    }
  }
  return undefined;
}

function blockBinding(block: Block, name: string): ResolvedBinding | undefined {
  for (const statement of block.statements) {
    const binding = lexicalStatementBinding(statement, name);
    if (binding) return binding;
  }
  return undefined;
}

function forBinding(
  statement: ForStatement | ForInStatement | ForOfStatement,
  name: string,
): ResolvedBinding | undefined {
  const initializer = isForStatement(statement) ? statement.initializer : statement.initializer;
  if (!initializer || !isVariableDeclarationList(initializer)) return undefined;
  return declarationListBinding(initializer, name, false);
}

function catchBinding(scope: Node, name: string): ResolvedBinding | undefined {
  if (!isCatchClause(scope) || !scope.variableDeclaration) return undefined;
  if (!bindingNameHas(scope.variableDeclaration.name, name)) return undefined;
  return { kind: "unresolved" };
}

function hoistedVarBinding(block: Block, name: string): ResolvedBinding | undefined {
  let found: ResolvedBinding | undefined;
  const visit = (node: Node): void => {
    if (found) return;
    if (
      isFunctionDeclaration(node) ||
      isFunctionExpression(node) ||
      isArrowFunction(node) ||
      isMethodDeclaration(node) ||
      isConstructorDeclaration(node)
    ) {
      return;
    }
    if (isVariableStatement(node)) {
      found = declarationListBinding(node.declarationList, name, true);
      return;
    }
    if (isVariableDeclarationList(node)) {
      found = declarationListBinding(node, name, true);
      return;
    }
    forEachChild(node, visit);
  };
  visit(block);
  return found;
}

function lexicalStatementBinding(statement: Statement, name: string): ResolvedBinding | undefined {
  if (isFunctionDeclaration(statement) && statement.name?.text === name) {
    return { kind: "value", value: statement };
  }
  if (isClassDeclaration(statement) && statement.name?.text === name) {
    return { kind: "unresolved" };
  }
  if (!isVariableStatement(statement)) return undefined;
  return declarationListBinding(statement.declarationList, name, false);
}

function declarationListBinding(
  list: VariableDeclarationList,
  name: string,
  varsOnly: boolean,
): ResolvedBinding | undefined {
  const isVar = (list.flags & (NodeFlags.Let | NodeFlags.Const)) === 0;
  if (varsOnly && !isVar) return undefined;
  if (!varsOnly && isVar) return undefined;
  for (const declaration of list.declarations) {
    if (!bindingNameHas(declaration.name, name)) continue;
    return declaration.initializer
      ? { kind: "value", value: declaration.initializer }
      : { kind: "unresolved" };
  }
  return undefined;
}

function moduleBinding(file: SourceFile, name: string): ResolvedBinding {
  for (const statement of file.statements) {
    const local = lexicalStatementBinding(statement, name);
    if (local) return local;
    if (isVariableStatement(statement)) {
      const varBinding = declarationListBinding(statement.declarationList, name, true);
      if (varBinding) return varBinding;
    }
  }
  return importBinding(file, name);
}

function importBinding(file: SourceFile, name: string): ResolvedBinding {
  for (const statement of file.statements) {
    const binding = importStatementBinding(statement, name);
    if (binding) return binding;
  }
  return { kind: "unresolved" };
}

function importStatementBinding(statement: Statement, name: string): ResolvedBinding | undefined {
  if (!isImportDeclaration(statement)) return undefined;
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return undefined;
  if (isNamespaceImport(bindings)) {
    return bindings.name.text === name
      ? officialImportKind(statement.moduleSpecifier, "official-namespace")
      : undefined;
  }
  if (!isNamedImports(bindings)) return undefined;
  return namedImportBinding(bindings, statement.moduleSpecifier, name);
}

function namedImportBinding(
  bindings: NamedImports,
  specifier: Expression,
  name: string,
): ResolvedBinding | undefined {
  for (const element of bindings.elements) {
    if (element.name.text !== name) continue;
    const imported = (element.propertyName ?? element.name).text;
    if (imported === WRAP_WORKER_HANDLER && isOfficialWrapSpecifier(specifier)) {
      return { kind: "official-wrap" };
    }
    return { kind: "unresolved" };
  }
  return undefined;
}

function officialImportKind(specifier: Expression, kind: "official-namespace"): ResolvedBinding {
  return isOfficialWrapSpecifier(specifier) ? { kind } : { kind: "unresolved" };
}

function isOfficialWrapSpecifier(specifier: Expression): boolean {
  return (
    isStringLiteral(specifier) &&
    (OFFICIAL_WRAP_WORKER_HANDLER_SPECIFIERS as readonly string[]).includes(specifier.text)
  );
}

function bindingNameHas(name: BindingName, target: string): boolean {
  if (isIdentifier(name)) return name.text === target;
  if (!isObjectBindingPattern(name) && !isArrayBindingPattern(name)) return false;
  for (const element of name.elements) {
    if (isOmittedExpression(element) || !isBindingElement(element)) continue;
    if (bindingNameHas(element.name, target)) return true;
  }
  return false;
}
