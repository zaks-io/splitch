import { z } from "zod";

/**
 * Structured before/after for one flag_change_events row.
 *
 * The stored `diff_json` is the only source. This module projects that record
 * into before/after objects; it never fills a missing field from live config or
 * from another row.
 */

export const FlagChangeActionSchema = z.enum(["created", "updated", "deleted"]);
export type FlagChangeAction = z.infer<typeof FlagChangeActionSchema>;

export const FlagChangeTargetTypeSchema = z.enum([
  "flag",
  "flag_config",
  "variant",
  "targeting_rule",
  "run",
]);
export type FlagChangeTargetType = z.infer<typeof FlagChangeTargetTypeSchema>;

export const FlagChangeFieldDiffSchema = z
  .object({
    name: z.string(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
  })
  .strict();
export type FlagChangeFieldDiff = z.infer<typeof FlagChangeFieldDiffSchema>;

export const FlagChangeDiffSchema = z
  .object({
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    fields: z.array(FlagChangeFieldDiffSchema),
    /**
     * Set only for historical deletion rows whose triggers store `diff_json`
     * NULL. Missing payloads on any other action fail the read.
     */
    unavailable: z.literal(true).optional(),
  })
  .strict();
export type FlagChangeDiff = z.infer<typeof FlagChangeDiffSchema>;

/**
 * Deletion triggers write `diff_json` NULL (no before snapshot on delete). That
 * is legitimate history, not a corrupt row: surface it as an explicit
 * unavailable diff rather than inventing an empty transition.
 */
export const UNAVAILABLE_FLAG_CHANGE_DIFF = {
  before: null,
  after: null,
  fields: [],
  unavailable: true,
} as const satisfies FlagChangeDiff;

const PAIR_LENGTH = 2;

export function parseFlagChangeDiff(
  diffJson: string | null,
  action: FlagChangeAction,
): FlagChangeDiff {
  if (diffJson === null) {
    if (action === "deleted") return { ...UNAVAILABLE_FLAG_CHANGE_DIFF };
    throw new Error("flag-change-diff: stored diff_json is required unless action is deleted");
  }
  const parsed: unknown = parseStoredJson(diffJson);
  if (!isPlainObject(parsed)) {
    throw new Error("flag-change-diff: stored diff_json must be a JSON object");
  }
  if (parsed.change === "added") {
    return lifecycleDiff(parsed, "added");
  }
  if (parsed.change === "removed") {
    return lifecycleDiff(parsed, "removed");
  }
  if (action === "created") {
    return landingDiff(parsed);
  }
  return transitionDiff(parsed, action);
}

function parseStoredJson(diffJson: string): unknown {
  try {
    return JSON.parse(diffJson);
  } catch {
    throw new Error("flag-change-diff: stored diff_json is not valid JSON");
  }
}

function lifecycleDiff(
  record: Record<string, unknown>,
  change: "added" | "removed",
): FlagChangeDiff {
  const payload: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name === "change") continue;
    payload[name] = value;
  }
  const fields = Object.entries(payload).map(([name, value]) =>
    change === "added" ? { name, after: value } : { name, before: value },
  );
  return {
    before: change === "removed" ? payload : null,
    after: change === "added" ? payload : null,
    fields,
  };
}

function landingDiff(record: Record<string, unknown>): FlagChangeDiff {
  return {
    before: null,
    after: { ...record },
    fields: Object.entries(record).map(([name, value]) => ({ name, after: value })),
  };
}

function transitionDiff(record: Record<string, unknown>, action: FlagChangeAction): FlagChangeDiff {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const fields: FlagChangeFieldDiff[] = [];
  let sawPair = false;
  for (const [name, value] of Object.entries(record)) {
    if (isStoredPair(value)) {
      sawPair = true;
      before[name] = value[0];
      after[name] = value[1];
      fields.push({ name, before: value[0], after: value[1] });
      continue;
    }
    after[name] = value;
    fields.push({ name, after: value });
  }
  if (!sawPair && action === "updated") {
    return landingDiff(record);
  }
  return {
    before: Object.keys(before).length > 0 ? before : null,
    after: Object.keys(after).length > 0 ? after : null,
    fields,
  };
}

function isStoredPair(value: unknown): value is [unknown, unknown] {
  return Array.isArray(value) && value.length === PAIR_LENGTH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
