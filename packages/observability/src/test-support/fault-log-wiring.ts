import ts from "typescript";

/** Static guard for the API log boundaries, including local logger/error aliases. */
export function unsafeFaultLogs(source: ts.SourceFile): number[] {
  const raw = new Set<string>();
  const loggers = new Set(["console", "logger"]);
  const serializers = new Set(["serializeFault"]);
  const aliases: Array<{ name: ts.BindingName; value: ts.Expression }> = [];
  const calls: ts.CallExpression[] = [];

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
    if (isSerializer(node)) return false;
    if (ts.isIdentifier(node)) return raw.has(node.text);
    if (ts.isPropertyAssignment(node)) return isRaw(node.initializer);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return rawProperty(node, isRaw);
    return emittedChildren(node).some(isRaw);
  }

  collect(source);
  function propagate(): boolean {
    const size = raw.size + loggers.size;
    aliases.forEach(updateAlias);
    return size !== raw.size + loggers.size;
  }
  function updateAlias(alias: { name: ts.BindingName; value: ts.Expression }): void {
    if (isLogger(alias.value)) addNames(alias.name, loggers);
    if (isRaw(alias.value)) addNames(alias.name, raw);
  }
  while (propagate()) {
    /* Resolve transitive aliases before checking sinks. */
  }
  return calls
    .filter(
      (call) => !isSerializer(call) && isLogger(call.expression) && call.arguments.some(isRaw),
    )
    .map((call) => source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1);
}

function collectAlias(
  node: ts.Node,
  aliases: Array<{ name: ts.BindingName; value: ts.Expression }>,
): void {
  if (ts.isVariableDeclaration(node) && node.initializer)
    aliases.push({ name: node.name, value: node.initializer });
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left)
  )
    aliases.push({ name: node.left, value: node.right });
}

function addNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements)
      if (ts.isBindingElement(element)) addNames(element.name, names);
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
  if (ts.isCatchClause(node) && node.variableDeclaration)
    addNames(node.variableDeclaration.name, raw);
  if (
    ts.isParameter(node) &&
    /^(cause|error|failure)$/.test(node.name.getText(source)) &&
    node.type?.getText(source) !== "string"
  )
    addNames(node.name, raw);
}

function rawProperty(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  isRaw: (node: ts.Node) => boolean,
): boolean {
  const field = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : node.argumentExpression.getText().replaceAll(/["']/g, "");
  if (field === "cause" || field === "stack") return true;
  if (field === "message" && isRaw(node.expression)) return true;
  return !ts.isIdentifier(node.expression) && isRaw(node.expression);
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
