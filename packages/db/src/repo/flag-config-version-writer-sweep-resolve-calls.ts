/**
 * Call-site classification for the flag_configs version sweep (SPL-350).
 */

import ts from "typescript";

export type ResolvedUpdateSite = {
  file: string;
  line: number;
  kind: "drizzle.update" | "scopedTable.update";
  setSource: string;
};

export type FacadeAnchor = {
  checker: ts.TypeChecker;
  facadeType: ts.Type;
  flagConfigs: ts.Symbol;
  relFile: (source: ts.SourceFile) => string;
};

function fail(message: string): never {
  throw new Error(`flag_configs version sweep: ${message}`);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function unwrapType(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let current = checker.getNonNullableType(type);
  for (let i = 0; i < 8; i++) {
    const constraint = checker.getBaseConstraintOfType(current);
    if (!constraint || constraint === current) break;
    current = checker.getNonNullableType(constraint);
  }
  return checker.getApparentType(current);
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function typesMatch(checker: ts.TypeChecker, a: ts.Type, b: ts.Type): boolean {
  return checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
}

function isFlagConfigsFacadeType(anchor: FacadeAnchor, type: ts.Type): boolean {
  return typesMatch(anchor.checker, unwrapType(anchor.checker, type), anchor.facadeType);
}

function objectLiteralText(node: ts.Expression, source: ts.SourceFile, where: string): string {
  if (!ts.isObjectLiteralExpression(node)) {
    fail(
      `${where}: UPDATE set/values is not an object literal ` +
        `(indirect .set(values) cannot be scored — fail loud)`,
    );
  }
  return node.getText(source);
}

function versionSiteLine(setObject: ts.ObjectLiteralExpression, source: ts.SourceFile): number {
  for (const prop of setObject.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name;
    const key =
      ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
        ? name.text
        : undefined;
    if (key === "version") return lineOf(source, prop);
  }
  return lineOf(source, setObject);
}

function isUpdateName(
  expr: ts.Expression,
): expr is ts.PropertyAccessExpression | ts.PropertyAccessChain {
  return (
    (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) &&
    expr.name.text === "update"
  );
}

function receiverOfUpdateAccess(
  expr: ts.Expression,
): { receiver: ts.Expression; viaCallApply: boolean } | undefined {
  if (isUpdateName(expr)) return { receiver: expr.expression, viaCallApply: false };
  if (
    !(ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) ||
    (expr.name.text !== "call" && expr.name.text !== "apply")
  ) {
    return undefined;
  }
  if (!isUpdateName(expr.expression)) return undefined;
  return { receiver: expr.expression.expression, viaCallApply: true };
}

function scopedFromValues(
  source: ts.SourceFile,
  values: ts.Expression | undefined,
  where: string,
): ResolvedUpdateSite {
  if (!values) fail(`${where}: scoped update missing values argument`);
  const setSource = objectLiteralText(values, source, where);
  return {
    file: where.split(":")[0] ?? "",
    line: versionSiteLine(values as ts.ObjectLiteralExpression, source),
    kind: "scopedTable.update",
    setSource,
  };
}

function tryMethodRefSite(
  anchor: FacadeAnchor,
  call: ts.CallExpression,
  source: ts.SourceFile,
): ResolvedUpdateSite | undefined {
  const sym = anchor.checker.getSymbolAtLocation(call.expression);
  if (!sym) return undefined;
  const resolved = resolveAlias(anchor.checker, sym);
  for (const decl of resolved.getDeclarations() ?? []) {
    const receiver = methodRefReceiver(decl);
    if (!receiver) continue;
    const recvType = anchor.checker.getTypeAtLocation(receiver);
    if (!isFlagConfigsFacadeType(anchor, recvType)) continue;
    const where = `${anchor.relFile(source)}:${lineOf(source, call)}`;
    const site = scopedFromValues(source, call.arguments[1], where);
    site.file = anchor.relFile(source);
    return site;
  }
  return undefined;
}

function methodRefReceiver(decl: ts.Declaration): ts.Expression | undefined {
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    return receiverOfUpdateAccess(decl.initializer)?.receiver;
  }
  if (!ts.isBindingElement(decl)) return undefined;
  const name = decl.propertyName ?? decl.name;
  const key = ts.isIdentifier(name) ? name.text : undefined;
  if (key !== "update") return undefined;
  const variable = decl.parent?.parent;
  if (!variable || !ts.isVariableDeclaration(variable) || !variable.initializer) return undefined;
  return variable.initializer;
}

export function tryScopedSite(
  anchor: FacadeAnchor,
  call: ts.CallExpression,
  source: ts.SourceFile,
): ResolvedUpdateSite | undefined {
  const access = receiverOfUpdateAccess(call.expression);
  if (access) {
    const recvType = anchor.checker.getTypeAtLocation(access.receiver);
    if (!isFlagConfigsFacadeType(anchor, recvType)) return undefined;
    const where = `${anchor.relFile(source)}:${lineOf(source, call)}`;
    const values = call.arguments[access.viaCallApply ? 2 : 1];
    const site = scopedFromValues(source, values, where);
    site.file = anchor.relFile(source);
    return site;
  }
  return tryMethodRefSite(anchor, call, source);
}

function tableArgSymbol(anchor: FacadeAnchor, tableArg: ts.Expression): ts.Symbol | undefined {
  const expr =
    ts.isAsExpression(tableArg) || ts.isTypeAssertionExpression(tableArg)
      ? tableArg.expression
      : tableArg;
  const direct = anchor.checker.getSymbolAtLocation(expr);
  if (direct) return resolveAlias(anchor.checker, direct);
  if (ts.isPropertyAccessExpression(expr)) {
    const nameSym = anchor.checker.getSymbolAtLocation(expr.name);
    return nameSym ? resolveAlias(anchor.checker, nameSym) : undefined;
  }
  return undefined;
}

function argIsFlagConfigsTable(anchor: FacadeAnchor, tableArg: ts.Expression): boolean {
  const sym = tableArgSymbol(anchor, tableArg);
  if (sym === anchor.flagConfigs) return true;
  const argType = unwrapType(anchor.checker, anchor.checker.getTypeAtLocation(tableArg));
  const decl = anchor.flagConfigs.valueDeclaration ?? tableArg;
  const flagType = unwrapType(
    anchor.checker,
    anchor.checker.getTypeOfSymbolAtLocation(anchor.flagConfigs, decl),
  );
  return typesMatch(anchor.checker, argType, flagType);
}

function chainedSetCall(updateCall: ts.CallExpression): ts.CallExpression | undefined {
  const parent = updateCall.parent;
  if (!ts.isPropertyAccessExpression(parent) && !ts.isPropertyAccessChain(parent)) return undefined;
  if (parent.expression !== updateCall || parent.name.text !== "set") return undefined;
  const setCall = parent.parent;
  if (!ts.isCallExpression(setCall) || setCall.expression !== parent) return undefined;
  return setCall;
}

export function tryDrizzleSite(
  anchor: FacadeAnchor,
  call: ts.CallExpression,
  source: ts.SourceFile,
): ResolvedUpdateSite | undefined {
  const expr = call.expression;
  if (!(ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr))) return undefined;
  if (expr.name.text !== "update") return undefined;
  const tableArg = call.arguments[0];
  if (!tableArg || !argIsFlagConfigsTable(anchor, tableArg)) return undefined;
  const where = `${anchor.relFile(source)}:${lineOf(source, call)}`;
  const setCall = chainedSetCall(call);
  if (!setCall) fail(`${where}: db.update(flagConfigs) with no chained .set(`);
  const setArg = setCall.arguments[0];
  if (!setArg) fail(`${where}: .set() missing argument`);
  const setSource = objectLiteralText(setArg, source, where);
  return {
    file: anchor.relFile(source),
    line: versionSiteLine(setArg as ts.ObjectLiteralExpression, source),
    kind: "drizzle.update",
    setSource,
  };
}
