/**
 * Fixed-point alias resolution for the flag_configs version-bump sweep (SPL-350).
 */

export type FlagConfigBindings = {
  /** Identifiers that refer to the flagConfigs table object. */
  tables: Set<string>;
  /** Identifiers that refer to a ScopedTable over flagConfigs. */
  facades: Set<string>;
  /**
   * Identifiers bound to a facade's `.update` — destructuring
   * (`const { update } = …`) or method reference (`const write = facade.update`).
   */
  directUpdates: Set<string>;
};

/** Strip a trailing `as Type` cast from an expression. */
function stripCast(expr: string): string {
  return expr
    .trim()
    .replace(/\s+as\s+[\s\S]+$/, "")
    .trim();
}

export function namesKnown(expr: string, names: Set<string>): boolean {
  const t = stripCast(expr);
  for (const name of names) {
    if (new RegExp(`^(?:\\w+\\.)*${name}$`).test(t)) return true;
  }
  return false;
}

function rhsKind(
  rhs: string,
  tables: Set<string>,
  facades: Set<string>,
): "table" | "facade" | null {
  const t = stripCast(rhs);
  const scoped = t.match(/^scopedTable\(\s*\w+\s*,\s*(\w+)\s*\)$/);
  if (scoped?.[1] && tables.has(scoped[1])) return "facade";
  if (namesKnown(t, tables)) return "table";
  if (namesKnown(t, facades)) return "facade";
  return null;
}

function addBinding(set: Set<string>, name: string | undefined): boolean {
  if (!name || set.has(name)) return false;
  set.add(name);
  return true;
}

/** `name`, `name as alias`, or `name: alias` → bound identifier. */
function destructuredName(part: string, key: string): string | null {
  const trimmed = part.trim();
  if (!trimmed) return null;
  const match = trimmed.match(new RegExp(`^${key}(?:\\s+as\\s+(\\w+)|\\s*:\\s*(\\w+))?$`));
  if (!match) return null;
  return match[1] ?? match[2] ?? key;
}

function addAll(source: string, pattern: RegExp, set: Set<string>): boolean {
  let changed = false;
  for (const match of source.matchAll(pattern)) {
    if (addBinding(set, match[1])) changed = true;
  }
  return changed;
}

function seedScopedFacades(source: string, tables: Set<string>, facades: Set<string>): boolean {
  let changed = false;
  for (const alias of tables) {
    changed =
      addAll(
        source,
        new RegExp(
          `(?:const|let)\\s+(\\w+)\\s*=\\s*scopedTable\\(\\s*\\w+\\s*,\\s*${alias}\\s*\\)`,
          "g",
        ),
        facades,
      ) || changed;
    changed =
      addAll(
        source,
        new RegExp(`(\\w+)\\s*:\\s*ScopedTable\\s*<\\s*typeof\\s+${alias}\\s*>`, "g"),
        facades,
      ) || changed;
  }
  // `table: typeof flagConfigsTable` — extract-a-helper params typed from a local facade.
  for (const facade of [...facades]) {
    changed =
      addAll(source, new RegExp(`(\\w+)\\s*:\\s*typeof\\s+${facade}\\b`, "g"), facades) || changed;
  }
  return changed;
}

function methodRefUpdate(rhs: string, facades: Set<string>): string | null {
  const match = stripCast(rhs).match(/^(\w+)\.update$/);
  if (!match?.[1] || !facades.has(match[1])) return null;
  return match[1];
}

function bindAssignment(
  name: string | undefined,
  rhs: string,
  tables: Set<string>,
  facades: Set<string>,
  directUpdates: Set<string>,
): boolean {
  let changed = false;
  const kind = rhsKind(rhs, tables, facades);
  if (kind === "table" && addBinding(tables, name)) changed = true;
  if (kind === "facade" && addBinding(facades, name)) changed = true;
  // `const writeConfig = flagConfigsTable.update` — same extraction shape as the narrowed export.
  if (methodRefUpdate(rhs, facades) && addBinding(directUpdates, name)) changed = true;
  return changed;
}

function seedSimpleAssignments(
  source: string,
  tables: Set<string>,
  facades: Set<string>,
  directUpdates: Set<string>,
): boolean {
  let changed = false;
  for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*([^;\n]+)/g)) {
    if (bindAssignment(match[1], match[2] ?? "", tables, facades, directUpdates)) changed = true;
  }
  return changed;
}

function bindDestructuredPart(
  part: string,
  rhs: string,
  tables: Set<string>,
  facades: Set<string>,
  directUpdates: Set<string>,
): boolean {
  let changed = false;
  if (facades.has(rhs)) {
    if (addBinding(directUpdates, destructuredName(part, "update") ?? undefined)) changed = true;
  }
  if (tables.has(rhs)) {
    if (addBinding(tables, destructuredName(part, "flagConfigs") ?? undefined)) changed = true;
  }
  return changed;
}

function seedDestructuring(
  source: string,
  tables: Set<string>,
  facades: Set<string>,
  directUpdates: Set<string>,
): boolean {
  let changed = false;
  for (const match of source.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*(\w+)\b/g)) {
    const rhs = match[2] ?? "";
    for (const part of (match[1] ?? "").split(",")) {
      if (bindDestructuredPart(part, rhs, tables, facades, directUpdates)) changed = true;
    }
  }
  return changed;
}

function seedOnce(
  source: string,
  tables: Set<string>,
  facades: Set<string>,
  directUpdates: Set<string>,
): boolean {
  return (
    seedScopedFacades(source, tables, facades) ||
    seedSimpleAssignments(source, tables, facades, directUpdates) ||
    seedDestructuring(source, tables, facades, directUpdates)
  );
}

/**
 * Fixed-point alias resolution: any `const X = <expr>` (including a destructuring
 * binding) whose RHS resolves to an already-known table or facade registers `X`
 * as the same kind. Iterates until stable so two-hop aliases resolve.
 */
export function resolveFlagConfigBindings(source: string): FlagConfigBindings {
  const tables = new Set<string>();
  const facades = new Set<string>();
  const directUpdates = new Set<string>();

  if (/\bflagConfigs\b/.test(source)) tables.add("flagConfigs");
  for (const match of source.matchAll(/\bflagConfigs\s+as\s+(\w+)\b/g)) {
    if (match[1]) tables.add(match[1]);
  }

  while (seedOnce(source, tables, facades, directUpdates)) {
    /* fixed point */
  }

  return { tables, facades, directUpdates };
}
