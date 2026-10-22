import {
  type Expression,
  isAsExpression,
  isAwaitExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isTypeAssertionExpression,
  type Node,
  type SourceFile,
} from "typescript";

export function locationOf(file: SourceFile, node: Node): string {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `${file.fileName}:${line + 1}:${character + 1}`;
}

export function unwrap(expression: Expression, { allowAwait = true } = {}): Expression {
  let current = expression;
  for (;;) {
    const next = unwrapOnce(current, allowAwait);
    if (!next) return current;
    current = next;
  }
}

function unwrapOnce(expression: Expression, allowAwait: boolean): Expression | undefined {
  if (isParenthesizedExpression(expression)) return expression.expression;
  if (isAsExpression(expression) || isSatisfiesExpression(expression)) return expression.expression;
  if (isNonNullExpression(expression)) return expression.expression;
  if (allowAwait && isAwaitExpression(expression)) return expression.expression;
  if (isTypeAssertionExpression(expression)) return expression.expression;
  return undefined;
}
