/**
 * Parsing helpers for the flag_configs version-bump structural sweep (SPL-350).
 * Kept out of the `.test.ts` so both stay under the repo file-size limit.
 */

import { namesKnown } from "./flag-config-version-writer-sweep-bindings";

export type UpdateSite = {
  file: string;
  line: number;
  kind: "drizzle.update" | "scopedTable.update" | "sql.UPDATE" | "drizzle.upsert";
  setSource: string;
};

/**
 * Allowlisted version RHS shapes that advance the row's own counter.
 * `<id>.version + 1`, `` sql`${<alias>.version} + 1` ``, or `` sql`version + 1` ``
 * (whitespace-insensitive). Rejects a RHS that names a spread-source identifier
 * (`patch.version + 1` after `...patch`) and any non-exact form such as
 * `patch.version ?? current.version + 1`.
 */
export function isBumpExpr(expr: string, spreadSources: ReadonlySet<string> = new Set()): boolean {
  const t = expr.trim().replace(/\s+/g, " ");
  if (/^sql`\$\{\w+\.version\} \+ 1`$/.test(t) || /^sql`version \+ 1`$/.test(t)) return true;
  const local = t.match(/^(\w+)\.version \+ 1$/);
  if (!local?.[1]) return false;
  return !spreadSources.has(local[1]);
}

export function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** Balanced `{ … }` starting at `open`, which must point at `{`. */
export function balancedBraces(source: string, open: number): string {
  if (source[open] !== "{") throw new Error(`expected '{' at ${open}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

/** First `{` at or after `from`, skipping whitespace. */
export function nextObjectStart(source: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (ch === "{") return i;
    if (!/\s/.test(ch)) {
      throw new Error(`expected object at ${from}, found ${JSON.stringify(ch)}`);
    }
  }
  throw new Error("expected object, found end of file");
}

function nestingDelta(ch: string): number {
  if (ch === "(" || ch === "{" || ch === "[") return 1;
  if (ch === ")" || ch === "}" || ch === "]") return -1;
  return 0;
}

/**
 * Index of the Nth top-level comma inside a `(…)` call (N=1 → first comma), or
 * -1 if the call ends first.
 */
function topLevelComma(source: string, callOpenParen: number, nth: number): number {
  let depth = 0;
  let seen = 0;
  for (let i = callOpenParen; i < source.length; i++) {
    depth += nestingDelta(source[i] ?? "");
    if ((source[i] ?? "") === "," && depth === 1 && ++seen === nth) return i;
    if (depth === 0 && (source[i] ?? "") === ")") return -1;
  }
  return -1;
}

/** Second argument object of `name.update(scope, values, …)`. */
export function secondArgObject(source: string, callOpenParen: number): string {
  const comma = topLevelComma(source, callOpenParen, 1);
  if (comma < 0) throw new Error("update call ended before second arg");
  return balancedBraces(source, nextObjectStart(source, comma + 1));
}

/** Advance `i` past one trivia unit: whitespace, line comment, or block comment. */
function skipOneTrivia(source: string, i: number): number | null {
  if (/\s/.test(source[i] ?? "")) return i + 1;
  if (source.startsWith("//", i)) {
    const nl = source.indexOf("\n", i);
    return nl < 0 ? source.length : nl + 1;
  }
  if (source.startsWith("/*", i)) {
    const end = source.indexOf("*/", i + 2);
    return end < 0 ? source.length : end + 2;
  }
  return null;
}

/** Advance `i` past whitespace and line/block comments. */
function skipTrivia(source: string, from: number): number {
  let i = from;
  for (;;) {
    const next = skipOneTrivia(source, i);
    if (next === null) return i;
    i = next;
  }
}

/**
 * `.set(` must be the next method on the same chain as `.update(…)`, allowing
 * whitespace and comments between them. Searching forward to end-of-file would
 * bind a later unrelated `.set({…})` to a dangling update.
 */
export function chainedSetAt(source: string, afterUpdate: number): number {
  const i = skipTrivia(source, afterUpdate);
  if (source.startsWith(".set(", i)) return i;
  return -1;
}

function callArgText(source: string, openParen: number): string | null {
  let end = -1;
  let inner = 0;
  for (let j = openParen; j < source.length; j++) {
    inner += nestingDelta(source[j] ?? "");
    if (inner === 0 && (source[j] ?? "") === ")") {
      end = j;
      break;
    }
  }
  if (end < 0) return null;
  const comma = topLevelComma(source, openParen, 1);
  return source.slice(openParen + 1, comma >= 0 ? comma : end).trim();
}

function isInsertCallOpen(source: string, openParen: number): boolean {
  return /\.insert\s*$/.test(source.slice(Math.max(0, openParen - 16), openParen));
}

/**
 * Table argument of the insert call that an onConflictDoUpdate is chained to,
 * or `null` when no insert is on the same chain (split-statement form).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: backwards walk over sibling call parens on a drizzle chain
export function insertArgOnUpsertChain(source: string, upsertAt: number): string | null {
  let depth = 0;
  for (let i = upsertAt - 1; i >= 0; i--) {
    const ch = source[i] ?? "";
    if (ch === ")") {
      depth += 1;
      continue;
    }
    if (ch === "(") {
      if (depth > 0) depth -= 1;
      // Sibling call parens on a chain (`.insert().values()`) are not nested;
      // finishing the backwards walk through `.values(…)` lands here at depth 0.
      if (depth === 0 && isInsertCallOpen(source, i)) return callArgText(source, i);
      continue;
    }
    if (ch === ";" && depth === 0) return null;
  }
  return null;
}

/**
 * The template literal that contains `at`, so a later `UPDATE … version = … + 1`
 * in the same file cannot satisfy this site's bump check.
 */
export function enclosingTemplateLiteral(source: string, at: number): string | null {
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (source[i] === "`") {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === "`") return source.slice(open, i + 1);
  }
  return null;
}

/**
 * Top-level comma-separated segments of an object literal body, respecting
 * nesting so nested objects/calls do not split early.
 */
function topLevelSegments(body: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  let inTemplate = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate) continue;
    depth += nestingDelta(ch);
    if (ch === "," && depth === 0) {
      segments.push(body.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(body.slice(start));
  return segments;
}

function objectHasVersionKey(objectSource: string): boolean {
  if (!objectSource.startsWith("{") || !objectSource.endsWith("}")) return false;
  return topLevelSegments(objectSource.slice(1, -1)).some((segment) =>
    /^\s*version\s*:/.test(segment),
  );
}

/**
 * Whether a spread RHS can introduce `version`. Bare identifiers (`...patch`)
 * can; object literals / ternaries of object literals that never name `version`
 * cannot — that is the `...(options.updatedAt ? { updatedAt } : {})` shape on
 * the rename writer, which must stay green without changing writer behavior.
 */
function spreadCanSetVersion(expr: string): boolean {
  const trimmed = expr.trim();
  if (objectHasVersionKey(trimmed)) return true;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return false;

  const question = trimmed.indexOf("?");
  if (question < 0) return true;
  let depth = 0;
  for (let i = question + 1; i < trimmed.length; i++) {
    const ch = trimmed[i] ?? "";
    depth += nestingDelta(ch);
    if (ch === ":" && depth === 0) {
      const left = trimmed.slice(question + 1, i).trim();
      const right = trimmed.slice(i + 1).trim();
      return objectHasVersionKey(left) || objectHasVersionKey(right);
    }
  }
  return true;
}

type EffectiveVersion = "bump" | "other" | "unknown" | null;

function spreadSourcesIn(objectSource: string): Set<string> {
  const sources = new Set<string>();
  if (!objectSource.startsWith("{") || !objectSource.endsWith("}")) return sources;
  for (const segment of topLevelSegments(objectSource.slice(1, -1))) {
    const match = segment.trim().match(/^\.\.\.(\w+)\s*$/);
    if (match?.[1]) sources.add(match[1]);
  }
  return sources;
}

function applySetSegment(
  effective: EffectiveVersion,
  segment: string,
  spreadSources: ReadonlySet<string>,
): EffectiveVersion {
  const trimmed = segment.trim();
  if (!trimmed) return effective;
  if (trimmed.startsWith("...")) {
    return spreadCanSetVersion(trimmed.slice(3)) ? "unknown" : effective;
  }
  const version = trimmed.match(/^version\s*:\s*([\s\S]+)$/);
  if (version?.[1] === undefined) return effective;
  return isBumpExpr(version[1], spreadSources) ? "bump" : "other";
}

/** SET-clause text inside a SQL UPDATE template (stops at WHERE). */
function sqlSetClause(template: string): string | null {
  const setAt = template.search(/\bSET\b/i);
  if (setAt < 0) return null;
  const afterSet = template.slice(setAt + 3);
  const whereAt = afterSet.search(/\bWHERE\b/i);
  return whereAt >= 0 ? afterSet.slice(0, whereAt) : afterSet;
}

function sqlVersionRhs(setClause: string): string | null {
  const match = setClause.match(/\bversion\s*=\s*([^,]+)/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * The bump must be the assignment that WINS, and its RHS must be an allowlisted
 * derivation of the row's own counter. `{ version: patch.version ?? current.version + 1 }`
 * still contains `+ 1` but lets a caller pin the CAS forever — exactly what the
 * sweep exists to prevent.
 */
export function bumpWins(site: UpdateSite): boolean {
  if (site.kind === "sql.UPDATE") {
    const clause = sqlSetClause(site.setSource);
    if (!clause) return false;
    const rhs = sqlVersionRhs(clause);
    if (!rhs) return false;
    return /^(?:(?:[\w"]+\.)?version) \+ 1$/i.test(rhs.replace(/\s+/g, " ").trim());
  }
  if (!site.setSource.startsWith("{") || !site.setSource.endsWith("}")) return false;
  const spreadSources = spreadSourcesIn(site.setSource);
  let effective: EffectiveVersion = null;
  for (const segment of topLevelSegments(site.setSource.slice(1, -1))) {
    effective = applySetSegment(effective, segment, spreadSources);
  }
  return effective === "bump";
}

/** Match db.update of a flagConfigs alias, optionally namespace-qualified or cast. */
export function drizzleUpdatePattern(alias: string): RegExp {
  return new RegExp(`\\.update\\(\\s*(?:\\w+\\.)*${alias}\\b(?:\\s+as\\s+[^,)]+)?\\s*\\)`, "g");
}

/** Whether an insert-arg expression names one of the flagConfigs aliases. */
export function insertArgIsFlagConfigs(arg: string, aliases: Set<string>): boolean {
  return namesKnown(arg, aliases);
}
