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

function nestingDelta(ch: string): number {
  if (ch === "(" || ch === "{" || ch === "[") return 1;
  if (ch === ")" || ch === "}" || ch === "]") return -1;
  return 0;
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
