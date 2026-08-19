import {
  forEachChild,
  isCallExpression,
  isComputedPropertyName,
  isFunctionLike,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  type Node,
  type Program,
  type SourceFile,
  SymbolFlags,
  type Symbol as TsSymbol,
  type TypeChecker,
} from "typescript";
import { visitNodes } from "./source-file-test-helpers";

interface SecurityTarget {
  exportName: string;
  filePath: string;
}

interface FormPostSurfaceDiscoveryOptions {
  originGuard: SecurityTarget;
  sessionCookieAccessor: SecurityTarget;
}

interface FormPostSecurity {
  reachesOriginGuard: boolean;
  reachesSessionCookie: boolean;
}

export interface FormPostSurfaceDiscovery {
  formPostSecurity(filePath: string, displayName: string): FormPostSecurity[];
}

export function createFormPostSurfaceDiscovery(
  program: Program,
  options: FormPostSurfaceDiscoveryOptions,
): FormPostSurfaceDiscovery {
  const checker = program.getTypeChecker();
  const originGuard = exportedTarget(program, checker, options.originGuard);
  const sessionCookieAccessor = exportedTarget(program, checker, options.sessionCookieAccessor);

  return {
    formPostSecurity(filePath, displayName) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) {
        throw new Error(`${displayName}: source file is absent from TypeScript program`);
      }
      return postHandlerRoots(sourceFile, checker).map((root) =>
        securityReachedFrom(root, checker, originGuard, sessionCookieAccessor),
      );
    },
  };
}

function postHandlerRoots(sourceFile: SourceFile, checker: TypeChecker): Node[] {
  const roots: Node[] = [];
  visitNodes(sourceFile, (node) => {
    if (propertyName(node, checker) !== "POST") return;
    if (isPropertyAssignment(node)) roots.push(node.initializer);
    if (isShorthandPropertyAssignment(node)) roots.push(node.name);
    if (isMethodDeclaration(node) && node.body) roots.push(node.body);
  });
  return roots;
}

function propertyName(node: Node, checker: TypeChecker): string | null {
  if (
    !isPropertyAssignment(node) &&
    !isShorthandPropertyAssignment(node) &&
    !isMethodDeclaration(node)
  ) {
    return null;
  }
  const { name } = node;
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (!isComputedPropertyName(name)) return null;
  if (isStringLiteral(name.expression) || isNoSubstitutionTemplateLiteral(name.expression)) {
    return name.expression.text;
  }
  const type = checker.getTypeAtLocation(name.expression);
  return type.isStringLiteral() ? type.value : null;
}

function securityReachedFrom(
  root: Node,
  checker: TypeChecker,
  originGuard: TsSymbol,
  sessionCookieAccessor: TsSymbol,
): FormPostSecurity {
  const reached = reachableCallSymbols(root, checker);
  return {
    reachesOriginGuard: reached.has(originGuard),
    reachesSessionCookie: reached.has(sessionCookieAccessor),
  };
}

function reachableCallSymbols(root: Node, checker: TypeChecker): Set<TsSymbol> {
  const reached = new Set<TsSymbol>();
  const visited = new Set<TsSymbol>();
  const pending: Node[] = [];

  function enqueueSymbol(symbol: TsSymbol): void {
    reached.add(symbol);
    if (visited.has(symbol)) return;
    visited.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      const implementation = callableImplementation(declaration);
      if (implementation) pending.push(implementation);
    }
  }

  function enqueueFunctionValue(value: Node): void {
    if (checker.getTypeAtLocation(value).getCallSignatures().length === 0) return;
    const symbol = calledSymbol(value, checker);
    if (symbol) {
      enqueueSymbol(symbol);
      return;
    }
    const implementation = callableImplementation(value);
    if (implementation) pending.push(implementation);
  }

  const rootSymbol = calledSymbol(root, checker);
  if (rootSymbol) enqueueSymbol(rootSymbol);
  else pending.push(root);

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    const directSymbol = calledSymbol(node, checker);
    if (directSymbol) enqueueSymbol(directSymbol);
    visitReachableNodes(node, (candidate) => {
      if (!isCallExpression(candidate)) return;
      const symbol = calledSymbol(candidate.expression, checker);
      if (symbol) enqueueSymbol(symbol);
      for (const argument of candidate.arguments) enqueueFunctionValue(argument);
    });
  }

  return reached;
}

function visitReachableNodes(root: Node, visitor: (node: Node) => void): void {
  visitor(root);
  forEachChild(root, (child) => {
    if (isFunctionLike(child)) return;
    visitReachableNodes(child, visitor);
  });
}

function calledSymbol(expression: Node, checker: TypeChecker): TsSymbol | null {
  if (isIdentifier(expression) && isShorthandPropertyAssignment(expression.parent)) {
    const valueSymbol = checker.getShorthandAssignmentValueSymbol(expression.parent);
    return valueSymbol ? resolveAlias(valueSymbol, checker) : null;
  }
  const location = isPropertyAccessExpression(expression) ? expression.name : expression;
  const symbol = checker.getSymbolAtLocation(location);
  return symbol ? resolveAlias(symbol, checker) : null;
}

function callableImplementation(declaration: Node): Node | null {
  if (isFunctionLike(declaration)) {
    return (declaration as Node & { body?: Node }).body ?? null;
  }
  const initializer = "initializer" in declaration ? declaration.initializer : undefined;
  return initializer && typeof initializer === "object" && "kind" in initializer
    ? (initializer as Node)
    : null;
}

function exportedTarget(program: Program, checker: TypeChecker, target: SecurityTarget): TsSymbol {
  const sourceFile = program.getSourceFile(target.filePath);
  if (!sourceFile) throw new Error(`${target.filePath}: security target source is absent`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exported = moduleSymbol
    ? checker
        .getExportsOfModule(moduleSymbol)
        .find((candidate) => candidate.getName() === target.exportName)
    : undefined;
  if (!exported) {
    throw new Error(`${target.filePath}: security target ${target.exportName} is not exported`);
  }
  return resolveAlias(exported, checker);
}

function resolveAlias(symbol: TsSymbol, checker: TypeChecker): TsSymbol {
  const seen = new Set<TsSymbol>();
  while (symbol.flags & SymbolFlags.Alias) {
    if (seen.has(symbol)) throw new Error(`Cyclic TypeScript alias for ${symbol.getName()}`);
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}
