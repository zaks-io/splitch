/**
 * Fail-loud raw SQL UPDATE detection for the flag_configs version sweep (SPL-350).
 * Tagged templates, `sql.raw(...)`, and `.prepare(...)` — table identity via checker.
 */

import ts from "typescript";
import {
  type FacadeAnchor,
  flagConfigsRelationOfExpr,
} from "./flag-config-version-writer-sweep-resolve-calls";

function fail(message: string): never {
  throw new Error(`flag_configs version sweep: ${message}`);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

type SqlParts = { statics: string[]; exprs: ts.Expression[] };

function literalParts(text: string): SqlParts {
  return { statics: [text], exprs: [] };
}

function templateExpressionParts(template: ts.TemplateExpression): SqlParts {
  const statics = [template.head.text];
  const exprs: ts.Expression[] = [];
  for (const span of template.templateSpans) {
    exprs.push(span.expression);
    statics.push(span.literal.text);
  }
  return { statics, exprs };
}

function templateNodeParts(template: ts.TemplateLiteral | ts.Expression): SqlParts | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(template) || ts.isStringLiteral(template)) {
    return literalParts(template.text);
  }
  if (ts.isTemplateExpression(template)) return templateExpressionParts(template);
  return undefined;
}

/** Join statics with «i» placeholders so UPDATE-table position is visible. */
function patterned(parts: SqlParts): string {
  let out = parts.statics[0] ?? "";
  for (let i = 0; i < parts.exprs.length; i++) {
    out += `«${i}»`;
    out += parts.statics[i + 1] ?? "";
  }
  return out;
}

function upsertTouchesFlagConfigs(anchor: FacadeAnchor, parts: SqlParts): boolean {
  if (/\bflag_configs\b/.test(parts.statics.join(""))) return true;
  return parts.exprs.some((e) => flagConfigsRelationOfExpr(anchor, e) === "flag_configs");
}

function failRaw(where: string, detail: string): never {
  fail(
    `${where}: ${detail} — use db.update(flagConfigs) or scopedTable.update ` +
      `so the version bump is enforced`,
  );
}

function assertNoRawFlagConfigsUpsert(anchor: FacadeAnchor, parts: SqlParts, where: string): void {
  const pattern = patterned(parts);
  if (!/\bDO\s+UPDATE\b/i.test(pattern) || !upsertTouchesFlagConfigs(anchor, parts)) return;
  failRaw(
    where,
    "INSERT…ON CONFLICT DO UPDATE of flag_configs cannot be scored by the type-driven sweep " +
      "(rejection is deliberate — raw upserts are unscored)",
  );
}

function assertNameTargetNotFlagConfigs(where: string, name: string): void {
  if (name !== "flag_configs") return;
  failRaw(where, "raw SQL UPDATE of flag_configs cannot be scored by the type-driven sweep");
}

function assertExprTargetNotFlagConfigs(
  anchor: FacadeAnchor,
  source: ts.SourceFile,
  where: string,
  expr: ts.Expression | undefined,
): void {
  if (!expr) {
    failRaw(where, "raw SQL UPDATE table interpolation is missing");
  }
  const relation = flagConfigsRelationOfExpr(anchor, expr);
  if (relation === "flag_configs") {
    failRaw(
      where,
      `raw SQL UPDATE of flag_configs via ${expr.getText(source)} cannot be scored ` +
        `by the type-driven sweep`,
    );
  }
  if (relation === "unknown") {
    failRaw(
      where,
      `raw SQL UPDATE table expression ${expr.getText(source)} cannot be resolved ` +
        `statically (unknown — not treated as not-flag_configs)`,
    );
  }
}

/**
 * Top-level `UPDATE <table>` targets. `DO UPDATE` is blanked so upsert SET
 * clauses are not mistaken for a top-level UPDATE of that table name.
 */
function updateTableTargets(
  parts: SqlParts,
): Array<{ kind: "name"; name: string } | { kind: "expr"; index: number }> {
  const blanked = patterned(parts).replace(/\bDO\s+UPDATE\b/gi, "DO /*upsert*/");
  const targets: Array<{ kind: "name"; name: string } | { kind: "expr"; index: number }> = [];
  const re = /\bUPDATE\s+(?:ONLY\s+)?(?:«(\d+)»|([`"']?)([A-Za-z_][\w]*)\2)/gi;
  for (const match of blanked.matchAll(re)) {
    if (match[1] !== undefined) {
      targets.push({ kind: "expr", index: Number(match[1]) });
    } else if (match[3]) {
      targets.push({ kind: "name", name: match[3] });
    }
  }
  return targets;
}

function assertPartsNotFlagConfigsUpdate(
  anchor: FacadeAnchor,
  source: ts.SourceFile,
  node: ts.Node,
  parts: SqlParts,
): void {
  const where = `${anchor.relFile(source)}:${lineOf(source, node)}`;
  assertNoRawFlagConfigsUpsert(anchor, parts, where);

  for (const target of updateTableTargets(parts)) {
    if (target.kind === "name") {
      assertNameTargetNotFlagConfigs(where, target.name);
      continue;
    }
    assertExprTargetNotFlagConfigs(anchor, source, where, parts.exprs[target.index]);
  }
}

function isPrepareCall(call: ts.CallExpression): boolean {
  const expr = call.expression;
  return (
    (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) &&
    expr.name.text === "prepare"
  );
}

function isSqlRawCall(call: ts.CallExpression): boolean {
  const expr = call.expression;
  return (
    (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) &&
    expr.name.text === "raw"
  );
}

function rawSqlPartsFromNode(node: ts.Node): SqlParts | undefined {
  if (ts.isTaggedTemplateExpression(node)) {
    return templateNodeParts(node.template);
  }
  if (!ts.isCallExpression(node) || (!isSqlRawCall(node) && !isPrepareCall(node))) {
    return undefined;
  }
  const arg = node.arguments[0];
  return arg ? templateNodeParts(arg) : undefined;
}

/**
 * Raw `sql\`…\``, `sql.raw(...)`, and `.prepare(...)` UPDATEs of `flag_configs`
 * (including aliased interpolations and unresolved table expressions) fail loud —
 * they cannot be scored by the type-driven drizzle/scopedTable selectors.
 */
export function assertNoRawFlagConfigsSqlUpdate(anchor: FacadeAnchor, source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    const parts = rawSqlPartsFromNode(node);
    if (parts) assertPartsNotFlagConfigsUpdate(anchor, source, node, parts);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
