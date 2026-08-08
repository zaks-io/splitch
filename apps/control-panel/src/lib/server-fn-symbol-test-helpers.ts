import {
  isAsExpression,
  isBindingElement,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAssertionExpression,
  isVariableDeclaration,
  SignatureKind,
  SymbolFlags,
  type CallExpression,
  type Expression,
  type Node,
  type Program,
  type SourceFile,
  type Symbol as TsSymbol,
  type TypeChecker,
} from "typescript";

const TANSTACK_START = "@tanstack/react-start";

export interface CreateServerFnResolver {
  isCreateServerFnCall(call: CallExpression, sourceFile: SourceFile, fileName: string): boolean;
}

export function createServerFnResolver(program: Program): CreateServerFnResolver {
  const checker = program.getTypeChecker();
  const createServerFn = createServerFnExport(program, checker);
  const createServerFnSignatures = new Set(
    checker
      .getSignaturesOfType(
        checker.getTypeOfSymbolAtLocation(createServerFn, symbolLocation(createServerFn)),
        SignatureKind.Call,
      )
      .map((signature) => signature.declaration),
  );

  return {
    isCreateServerFnCall(call, sourceFile, fileName) {
      const resolved = resolveExpressionSymbol(call.expression, checker, new Set());
      if (resolved === createServerFn) return true;
      if (!couldCallCreateServerFn(call, checker, createServerFnSignatures)) return false;
      throw new Error(
        `${fileName}: createServerFn callee is not statically resolvable: ${JSON.stringify(call.getText(sourceFile))}`,
      );
    },
  };
}

function createServerFnExport(program: Program, checker: TypeChecker): TsSymbol {
  for (const moduleSpecifier of program.getSourceFiles().flatMap((sourceFile) =>
    sourceFile.statements.flatMap((statement) => {
      const moduleSpecifier = tanstackModuleSpecifier(statement);
      return moduleSpecifier ? [moduleSpecifier] : [];
    }),
  )) {
    const exported = moduleExport(moduleSpecifier, "createServerFn", checker);
    if (exported) return resolveAlias(exported, checker);
  }
  throw new Error(`Cannot resolve createServerFn export from ${TANSTACK_START}`);
}

function tanstackModuleSpecifier(statement: Node) {
  if (!isImportDeclaration(statement) && !isExportDeclaration(statement)) return null;
  const moduleSpecifier = statement.moduleSpecifier;
  if (!moduleSpecifier) return null;
  return isStringLiteral(moduleSpecifier) && moduleSpecifier.text === TANSTACK_START
    ? moduleSpecifier
    : null;
}

function moduleExport(
  moduleSpecifier: Node,
  exportName: string,
  checker: TypeChecker,
): TsSymbol | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
  return moduleSymbol
    ? checker
        .getExportsOfModule(moduleSymbol)
        .find((candidate) => candidate.getName() === exportName)
    : undefined;
}

function resolveExpressionSymbol(
  expression: Expression,
  checker: TypeChecker,
  seen: Set<TsSymbol>,
): TsSymbol | null {
  const unwrapped = unwrapExpression(expression);
  const symbol = checker.getSymbolAtLocation(
    isPropertyAccessExpression(unwrapped) ? unwrapped.name : unwrapped,
  );
  if (!symbol) return null;
  return resolveSymbol(symbol, checker, seen);
}

function resolveSymbol(
  symbol: TsSymbol,
  checker: TypeChecker,
  seen: Set<TsSymbol>,
): TsSymbol | null {
  const unaliased = resolveAlias(symbol, checker);
  if (seen.has(unaliased)) return null;
  seen.add(unaliased);

  for (const declaration of unaliased.declarations ?? []) {
    const resolved = resolveDeclaration(declaration, checker, seen);
    if (resolved) return resolved;
  }
  return unaliased;
}

function resolveDeclaration(
  declaration: Node,
  checker: TypeChecker,
  seen: Set<TsSymbol>,
): TsSymbol | null {
  if (isVariableDeclaration(declaration) && declaration.initializer) {
    return resolveExpressionSymbol(declaration.initializer, checker, seen);
  }
  return isBindingElement(declaration) ? resolveBindingElement(declaration, checker, seen) : null;
}

function resolveBindingElement(
  binding: Node & { name: Node; propertyName?: Node },
  checker: TypeChecker,
  seen: Set<TsSymbol>,
): TsSymbol | null {
  const pattern = binding.parent;
  const declaration = pattern.parent;
  if (!isVariableDeclaration(declaration) || !declaration.initializer) return null;
  const name = propertyText(binding.propertyName ?? binding.name);
  if (!name) return null;
  const property = checker.getPropertyOfType(
    checker.getTypeAtLocation(declaration.initializer),
    name,
  );
  return property ? resolveSymbol(property, checker, seen) : null;
}

function resolveAlias(symbol: TsSymbol, checker: TypeChecker): TsSymbol {
  const seen = new Set<TsSymbol>();
  while (symbol.flags & SymbolFlags.Alias) {
    if (seen.has(symbol)) return symbol;
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function couldCallCreateServerFn(
  call: CallExpression,
  checker: TypeChecker,
  signatures: ReadonlySet<Node | undefined>,
): boolean {
  const signature = checker.getResolvedSignature(call);
  return !!signature && signatures.has(signature.declaration);
}

function symbolLocation(symbol: TsSymbol): Node {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) throw new Error("createServerFn export has no declaration");
  return declaration;
}

function unwrapExpression(expression: Expression): Expression {
  while (
    isParenthesizedExpression(expression) ||
    isAsExpression(expression) ||
    isSatisfiesExpression(expression) ||
    isTypeAssertionExpression(expression) ||
    isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function propertyText(node: Node): string | null {
  return isIdentifier(node) || isStringLiteral(node) ? node.text : null;
}
