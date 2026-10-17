import ts from "typescript";

export function propertyName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  )
    return node.argumentExpression.text;
  return undefined;
}

export function addBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements)
      if (ts.isBindingElement(element)) addBindingNames(element.name, names);
}

export function rejectionBindings(source: ts.SourceFile): Map<ts.Node, ts.BindingName> {
  const handlers = new Map<ts.Node, ts.BindingName>();
  const functions = new Map<string, ts.FunctionDeclaration | ts.Expression>();
  const callbacks: ts.Expression[] = [];
  function collect(node: ts.Node): void {
    if (ts.isCatchClause(node) && node.variableDeclaration)
      handlers.set(node.block, node.variableDeclaration.name);
    collectFunction(node, functions);
    const callback = rejectionCallback(node);
    if (callback) callbacks.push(callback);
    ts.forEachChild(node, collect);
  }
  collect(source);
  for (const callback of callbacks) {
    const handler = resolveCallback(callback, functions);
    if (
      (ts.isArrowFunction(handler) ||
        ts.isFunctionExpression(handler) ||
        ts.isFunctionDeclaration(handler)) &&
      handler.body &&
      handler.parameters[0]
    )
      handlers.set(handler.body, handler.parameters[0].name);
  }
  return handlers;
}

function resolveCallback(
  callback: ts.Expression,
  functions: Map<string, ts.FunctionDeclaration | ts.Expression>,
): ts.Node {
  let handler: ts.Node = callback;
  const seen = new Set<string>();
  while (ts.isIdentifier(handler) && !seen.has(handler.text)) {
    const next = functions.get(handler.text);
    if (!next) break;
    seen.add(handler.text);
    handler = next;
  }
  return handler;
}

function collectFunction(
  node: ts.Node,
  functions: Map<string, ts.FunctionDeclaration | ts.Expression>,
): void {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
    functions.set(node.name.text, node.initializer);
}

export function rejectionCallback(node: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const method = propertyName(node.expression);
  if (method === "catch") return node.arguments[0];
  if (method === "then") return node.arguments[1];
  return undefined;
}
