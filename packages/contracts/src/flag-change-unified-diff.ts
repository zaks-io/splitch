import type { FlagChangeDiff, FlagChangeFieldDiff } from "./flag-change-diff";

export interface FlagChangeUnifiedSource {
  seq: number;
  flagKey: string;
  environmentId: string | null;
  action: string;
  targetType: string;
  changedAt: string;
  diff: FlagChangeDiff;
}

/**
 * Unified text of stored before/after values. The lines are the stored field
 * names and values; nothing is reconstructed from live Flag Configuration.
 */
export function renderFlagChangeUnifiedDiff(entries: readonly FlagChangeUnifiedSource[]): string {
  return entries.map(renderEntry).join("\n");
}

function renderEntry(entry: FlagChangeUnifiedSource): string {
  const path = entryPath(entry);
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ ${entry.action} ${entry.targetType} ${entry.changedAt} @@`,
    ...fieldLines(entry.diff.fields),
  ];
  return `${lines.join("\n")}\n`;
}

function entryPath(entry: FlagChangeUnifiedSource): string {
  const environment = entry.environmentId ?? "app";
  return `flag-changes/${entry.flagKey}@${environment}/seq-${entry.seq}`;
}

function fieldLines(fields: readonly FlagChangeFieldDiff[]): string[] {
  return fields.flatMap((field) => {
    const hasBefore = Object.hasOwn(field, "before");
    const hasAfter = Object.hasOwn(field, "after");
    if (hasBefore && hasAfter && valuesEqual(field.before, field.after)) {
      return [];
    }
    const lines: string[] = [];
    if (hasBefore) lines.push(`-${field.name}: ${stableJson(field.before)}`);
    if (hasAfter) lines.push(`+${field.name}: ${stableJson(field.after)}`);
    return lines;
  });
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => sortKeys(nested));
}

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}
