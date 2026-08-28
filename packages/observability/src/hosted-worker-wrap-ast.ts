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

export function unwrap(expression: Expression): Expression {
  let current = expression;
  for (;;) {
    const next = unwrapOnce(current);
    if (!next) return current;
    current = next;
  }
}

function unwrapOnce(expression: Expression): Expression | undefined {
  if (isParenthesizedExpression(expression)) return expression.expression;
  if (isAsExpression(expression) || isSatisfiesExpression(expression)) return expression.expression;
  if (isNonNullExpression(expression) || isAwaitExpression(expression))
    return expression.expression;
  if (isTypeAssertionExpression(expression)) return expression.expression;
  return undefined;
}
