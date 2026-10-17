import ts from "typescript";
import { addBindingNames, rejectionBindings, rejectionCallback } from "./fault-catch-bindings";
import { type FaultAlias, objectPropertyValue } from "./fault-log-properties";

/**
 * Raw-log tripwire for catch/then rejection callbacks (including direct logger callbacks),
 * logger/binding aliases and object properties. Taint survives String, toString, templates,
 * JSON.stringify and message/stack/cause/params/query reads; serialized detail and explicit
 * domain metadata are allowed. Deliberate evasion is outside this guard's scope.
 */
export function unsafeFaultLogs(source: ts.SourceFile): number[] {
  const raw = new Set<string>();
  const loggers = new Set(["console", "logger"]);
  const serializers = new Set(["serializeFault"]);
  const aliases: FaultAlias[] = [];
  const calls: ts.CallExpression[] = [];
  const evaluating = new Set<ts.Node>();
  for (const binding of rejectionBindings(source).values()) addBindingNames(binding, raw);

  function collect(node: ts.Node): void {
    collectRawBindings(node, raw, source);
    collectAlias(node, aliases);
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isImportSpecifier(node) && node.propertyName?.text === "serializeFault")
      serializers.add(node.name.text);
    if (ts.isImportSpecifier(node) && /logger/i.test(node.propertyName?.text ?? ""))
      loggers.add(node.name.text);
    ts.forEachChild(node, collect);
  }

  function isSerializer(node: ts.Node): boolean {
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      serializers.has(node.expression.text)
    );
  }

  function isLogger(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) return loggers.has(node.text) || /logger/i.test(node.text);
    if (ts.isPropertyAccessExpression(node))
      return /logger/i.test(node.name.text) || isLogger(node.expression);
    return loggerReceivers(node).some(isLogger);
  }

  function isRaw(node: ts.Node): boolean {
    if (evaluating.has(node)) return false;
    evaluating.add(node);
    try {
      return rawValue(node);
    } finally {
      evaluating.delete(node);
    }
  }

  function rawValue(node: ts.Node): boolean {
    if (isSerializer(node)) return false;
    if (isErrorConstruction(node)) return true;
    if (ts.isIdentifier(node)) return raw.has(node.text);
    if (ts.isPropertyAssignment(node)) return isRaw(node.initializer);
    if (isPropertyRead(node)) return isRawProperty(node);
    return emittedChildren(node).some(isRaw);
  }

  function isRawProperty(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
    const value = objectPropertyValue(node, aliases);
    return value ? isRaw(value) : rawProperty(node, isRaw);
  }

  collect(source);
  function propagate(): boolean {
    const size = raw.size + loggers.size;
    aliases.forEach(updateAlias);
    return size !== raw.size + loggers.size;
  }
  function updateAlias(alias: { name: ts.BindingName; value: ts.Expression }): void {
    if (isLogger(alias.value)) addBindingNames(alias.name, loggers);
    if (isRaw(alias.value)) addBindingNames(alias.name, raw);
  }
  while (propagate()) {
    /* Resolve transitive aliases before checking sinks. */
  }
  return calls
    .filter((call) => {
      const callback = rejectionCallback(call);
      return (
        (callback && isLogger(callback)) ||
        (!isSerializer(call) && isLogger(call.expression) && call.arguments.some(isRaw))
      );
    })
    .map((call) => source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1);
}

function collectAlias(node: ts.Node, aliases: FaultAlias[]): void {
  if (ts.isVariableDeclaration(node) && node.initializer)
    aliases.push({ name: node.name, value: node.initializer });
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left)
  )
    aliases.push({ name: node.left, value: node.right });
}

function children(node: ts.Node): ts.Node[] {
  const values: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    values.push(child);
  });
  return values;
}

function emittedChildren(node: ts.Node): ts.Node[] {
  return ts.isConditionalExpression(node) ? [node.whenTrue, node.whenFalse] : children(node);
}

function collectRawBindings(node: ts.Node, raw: Set<string>, source: ts.SourceFile): void {
  if (
    ts.isParameter(node) &&
    (/^(cause|error|failure)$/.test(node.name.getText(source)) || isErrorType(node.type)) &&
    node.type?.getText(source) !== "string"
  )
    addBindingNames(node.name, raw);
}

function isErrorType(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (ts.isTypeReferenceNode(node)) return /Error$/.test(node.typeName.getText());
  return ts.isUnionTypeNode(node) && node.types.some(isErrorType);
}

function rawProperty(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  isRaw: (node: ts.Node) => boolean,
): boolean {
  const field = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : node.argumentExpression.getText().replaceAll(/["']/g, "");
  if (field === "cause" || field === "stack") return true;
  if (["message", "params", "query", "toString"].includes(field)) return isRaw(node.expression);
  return !ts.isIdentifier(node.expression) && isRaw(node.expression);
}

function isErrorConstruction(node: ts.Node): boolean {
  return ts.isNewExpression(node) && /Error$/.test(node.expression.getText());
}

function isPropertyRead(
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function loggerReceivers(node: ts.Node): ts.Node[] {
  if (ts.isBinaryExpression(node)) return [node.left, node.right];
  if (
    ts.isElementAccessExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isCallExpression(node)
  )
    return [node.expression];
  return [];
}
