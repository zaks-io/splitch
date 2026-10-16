import ts from "typescript";
import { propertyName } from "./fault-catch-bindings";

export interface FaultAlias {
  name: ts.BindingName;
  value: ts.Expression;
}

export function objectPropertyValue(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  aliases: FaultAlias[],
  seen = new Set<string>(),
): ts.Expression | undefined {
  const object = resolveValue(node.expression, aliases, seen);
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const field = propertyName(node);
  for (const property of object.properties) {
    if (property.name?.getText().replaceAll(/["'`]/g, "") !== field) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
}

function resolveValue(
  node: ts.Expression,
  aliases: FaultAlias[],
  seen: Set<string>,
): ts.Expression | undefined {
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return undefined;
    seen.add(node.text);
    const alias = aliases.find((alias) => alias.name.getText() === node.text);
    return alias && resolveValue(alias.value, aliases, seen);
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return resolveValue(node.expression, aliases, seen);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return objectPropertyValue(node, aliases, seen);
  return node;
}
