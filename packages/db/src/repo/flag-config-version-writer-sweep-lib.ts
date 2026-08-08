/**
 * Parsing helpers for the flag_configs version-bump structural sweep (SPL-350).
 * Kept out of the `.test.ts` so both stay under the repo file-size limit.
 */

export type UpdateSite = {
  file: string;
  line: number;
  kind: "drizzle.update" | "scopedTable.update" | "sql.UPDATE" | "drizzle.upsert";
  setSource: string;
};

/**
 * Allowlisted version RHS shapes that advance the row's own counter.
 * Exactly `current.version + 1`, `` sql`${<alias>.version} + 1` ``, or
 * `` sql`version + 1` `` (whitespace-insensitive). A substring `+ 1` is not
 * enough: `patch.version ?? current.version + 1` still contains `+ 1` while a
 * caller can pin the CAS forever. `+ 10` / `+ 100` are also rejected.
 */
function isBumpExpr(expr: string): boolean {
  const t = expr.trim().replace(/\s+/g, " ");
  return (
    /^current\.version \+ 1$/.test(t) ||
    /^sql`\$\{\w+\.version\} \+ 1`$/.test(t) ||
    /^sql`version \+ 1`$/.test(t)
  );
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

/**
 * Bindings that refer to the flagConfigs table object, including
 * `import { flagConfigs as cfg }` aliases and `const x = flagConfigs`.
 */
export function tableAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  if (/\bflagConfigs\b/.test(source)) aliases.add("flagConfigs");
  for (const match of source.matchAll(/\bflagConfigs\s+as\s+(\w+)\b/g)) {
    if (match[1]) aliases.add(match[1]);
  }
  for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*flagConfigs\b/g)) {
    if (match[1]) aliases.add(match[1]);
  }
  return aliases;
}

/**
 * Facade bindings whose table is flagConfigs: `scopedTable(db, alias)` locals
 * and any parameter typed `ScopedTable<typeof alias>`, whatever the parameter
 * is named — the type is the closure, not a hardcoded identifier.
 */
export function scopedFacades(source: string, aliases: Set<string>): Set<string> {
  const facades = new Set<string>();
  for (const alias of aliases) {
    collectFacadeNames(source, alias, facades);
  }
  return facades;
}

function collectFacadeNames(source: string, alias: string, facades: Set<string>): void {
  const local = new RegExp(
    `(?:const|let)\\s+(\\w+)\\s*=\\s*scopedTable\\(\\s*\\w+\\s*,\\s*${alias}\\s*\\)`,
    "g",
  );
  for (const match of source.matchAll(local)) {
    if (match[1]) facades.add(match[1]);
  }
  const param = new RegExp(`(\\w+)\\s*:\\s*ScopedTable\\s*<\\s*typeof\\s+${alias}\\s*>`, "g");
  for (const match of source.matchAll(param)) {
    if (match[1]) facades.add(match[1]);
  }
}

/**
 * `.set(` must be the next method on the same chain as `.update(…)`. Searching
 * forward to end-of-file would bind a later unrelated `.set({…})` to a dangling
 * update and score that later object's bump.
 */
export function chainedSetAt(source: string, afterUpdate: number): number {
  let i = afterUpdate;
  while (i < source.length && /\s/.test(source[i] ?? "")) i += 1;
  if (source.startsWith(".set(", i)) return i;
  return -1;
}

/** Walk back to the start of the current statement (after `;` or file start). */
export function statementStart(source: string, at: number): number {
  for (let i = at; i >= 0; i--) {
    if (source[i] === ";") return i + 1;
  }
  return 0;
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

function applySetSegment(effective: EffectiveVersion, segment: string): EffectiveVersion {
  const trimmed = segment.trim();
  if (!trimmed) return effective;
  if (trimmed.startsWith("...")) {
    return spreadCanSetVersion(trimmed.slice(3)) ? "unknown" : effective;
  }
  const version = trimmed.match(/^version\s*:\s*([\s\S]+)$/);
  if (version?.[1] === undefined) return effective;
  return isBumpExpr(version[1]) ? "bump" : "other";
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
  let effective: EffectiveVersion = null;
  for (const segment of topLevelSegments(site.setSource.slice(1, -1))) {
    effective = applySetSegment(effective, segment);
  }
  return effective === "bump";
}
