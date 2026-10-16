import ts from "typescript";
import { propertyName } from "./fault-catch-bindings";

/**
 * Engine-stack trust tripwire: dot/computed assignments, Object.assign (literal,
 * shorthand and spread sources), Object.defineProperty/defineProperties, Reflect.set
 * and Reflect.defineProperty writes to stack or Error.prepareStackTrace. Local source
 * aliases are followed. Deliberate evasion is outside this ordinary-code guard's scope.
 */
export function unsafeStackWrites(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const aliases = new Map<string, ts.Expression>();
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      aliases.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  }
  function hasField(node: ts.Node, field: string, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const value = aliases.get(node.text);
      return !!value && hasField(value, field, seen);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return hasField(node.expression, field, seen);
    return (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((property) =>
        ts.isSpreadAssignment(property)
          ? hasField(property.expression, field, seen)
          : literalName(property.name) === field,
      )
    );
  }
  function unsafeCall(node: ts.CallExpression): boolean {
    const callee = node.expression;
    if (!isPropertyRead(callee)) return false;
    const owner = callee.expression.getText(source);
    const method = propertyName(callee);
    const [target, key] = node.arguments;
    if (!target || !key) return false;
    const fields = protectedFields(target);
    if (owner === "Object") return objectWrite(method, node.arguments, fields);
    return (
      owner === "Reflect" && reflectsFieldWrite(method) && fields.includes(literalName(key) ?? "")
    );
  }
  function objectWrite(
    method: string | undefined,
    args: ts.NodeArray<ts.Expression>,
    fields: string[],
  ): boolean {
    const key = args[1];
    if (!key) return false;
    if (method === "assign")
      return args.slice(1).some((arg) => fields.some((field) => hasField(arg, field)));
    if (method === "defineProperties") return fields.some((field) => hasField(key, field));
    return method === "defineProperty" && fields.includes(literalName(key) ?? "");
  }
  function reflectsFieldWrite(method: string | undefined): boolean {
    return method === "set" || method === "defineProperty";
  }
  function visit(node: ts.Node): void {
    const assignment =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isStackTarget(node.left);
    if (assignment || (ts.isCallExpression(node) && unsafeCall(node)))
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    ts.forEachChild(node, visit);
  }
  collect(source);
  visit(source);
  return lines;
}

function literalName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isComputedPropertyName(node)) return literalName(node.expression);
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  return undefined;
}

function isStackTarget(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node)) return isStackTarget(node.expression);
  const field = propertyName(node);
  if (field === "stack") return true;
  return (
    field === "prepareStackTrace" &&
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isErrorConstructor(node.expression)
  );
}

function isErrorConstructor(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "Error";
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return isErrorConstructor(node.expression);
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    propertyName(node) === "Error" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "globalThis"
  );
}

function isPropertyRead(
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function protectedFields(target: ts.Node): string[] {
  return isErrorConstructor(target) ? ["stack", "prepareStackTrace"] : ["stack"];
}
