import ts from "typescript";
import { propertyName } from "./fault-catch-bindings";

export function faultReportCalls(source: ts.SourceFile): Set<ts.CallExpression> {
  const factories = new Set(["createWorkerFaultReporter"]);
  const reporters = new Set<string>();
  const aliases: Array<{ name: string; value: ts.Expression }> = [];
  const calls: ts.CallExpression[] = [];
  function collect(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      aliases.push({ name: node.name.text, value: node.initializer });
    collectImport(node, factories, reporters);
    ts.forEachChild(node, collect);
  }
  collect(source);
  let previousSize = -1;
  while (previousSize !== factories.size + reporters.size) {
    previousSize = factories.size + reporters.size;
    for (const alias of aliases) {
      if (isFactory(alias.value)) factories.add(alias.name);
      if (isReporter(alias.value)) reporters.add(alias.name);
    }
  }
  function isFactory(node: ts.Node): boolean {
    return factories.has(referenceName(node));
  }
  function isReporter(node: ts.Node): boolean {
    if (ts.isCallExpression(node)) return isFactory(node.expression);
    const name = referenceName(node);
    return reporters.has(name) || isReporterName(name);
  }
  return new Set(calls.filter((call) => isReporter(call.expression)));
}

function collectImport(node: ts.Node, factories: Set<string>, reporters: Set<string>): void {
  if (!ts.isImportSpecifier(node) || !node.propertyName) return;
  if (factories.has(node.propertyName.text)) factories.add(node.name.text);
  if (isReporterName(node.propertyName.text)) reporters.add(node.name.text);
}

function referenceName(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text;
  return propertyName(node) ?? "";
}

function isReporterName(name: string): boolean {
  return /^(report\w*Fault|reportFault|onFault|onError)$/i.test(name);
}
