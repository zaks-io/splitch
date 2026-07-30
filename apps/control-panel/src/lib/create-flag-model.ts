import type { FlagsCreateInput } from "@splitch/contracts/route-types";
import { z } from "zod";
import type { MutationErrorSurface } from "./api";

/**
 * One value type per Flag. These are the four the Variant leaf's `value` union
 * accepts; the same string doubles as the Flag's JSON Schema `type`, so the
 * Worker enforces the editor's invariant instead of trusting it.
 */
export const VARIANT_VALUE_TYPES = ["boolean", "string", "number", "object"] as const;
export type VariantValueType = (typeof VARIANT_VALUE_TYPES)[number];

const VariantDraftSchema = z.object({
  name: z.string(),
  /** Raw editor text. Parsed against `valueType` only at validation time. */
  value: z.string(),
  description: z.string(),
});

/**
 * The draft crosses the wire to the create server fn, so its shape is parsed
 * rather than cast. Semantic rules live in `draftIssues`; this only guarantees
 * the fields exist with the right primitive types (ADR-0025, ADR-0036).
 */
export const FlagDraftSchema = z.object({
  key: z.string(),
  valueType: z.enum(VARIANT_VALUE_TYPES),
  variants: z.array(VariantDraftSchema),
  /** Index into `variants`. -1 once the Default is removed — never auto-promoted. */
  defaultIndex: z.number().int(),
});

export type VariantDraft = z.infer<typeof VariantDraftSchema>;
export type FlagDraft = z.infer<typeof FlagDraftSchema>;

export type DraftIssue = { path: string; message: string };

/** The zero-configuration preset: a new Flag opens as an on/off toggle. */
export function booleanPresetDraft(): FlagDraft {
  return {
    key: "",
    valueType: "boolean",
    variants: [
      { name: "disabled", value: "false", description: "" },
      { name: "enabled", value: "true", description: "" },
    ],
    defaultIndex: 0,
  };
}

export function emptyVariantDraft(): VariantDraft {
  return { name: "", value: "", description: "" };
}

/** Seed rows for a value type the drafted values cannot survive a switch to. */
function seedForValueType(valueType: VariantValueType): VariantDraft[] {
  if (valueType === "boolean") return booleanPresetDraft().variants;
  return [emptyVariantDraft(), emptyVariantDraft()];
}

/** True when any drafted value would fail to parse as the incoming type. */
export function typeSwitchClearsValues(
  variants: VariantDraft[],
  nextType: VariantValueType,
): boolean {
  return variants.some(
    (variant) => variant.value.trim() !== "" && parseVariantValue(variant.value, nextType) === null,
  );
}

export function switchValueType(draft: FlagDraft, valueType: VariantValueType): FlagDraft {
  if (valueType === draft.valueType) return draft;
  if (!typeSwitchClearsValues(draft.variants, valueType)) return { ...draft, valueType };

  const variants = seedForValueType(valueType);
  return {
    ...draft,
    valueType,
    variants,
    defaultIndex: Math.min(draft.defaultIndex, variants.length - 1),
  };
}

export function moveVariant(draft: FlagDraft, from: number, to: number): FlagDraft {
  if (to < 0 || to >= draft.variants.length || from === to) return draft;

  const variants = [...draft.variants];
  const [moved] = variants.splice(from, 1);
  if (!moved) return draft;
  variants.splice(to, 0, moved);

  return { ...draft, variants, defaultIndex: reindexDefault(draft.defaultIndex, from, to) };
}

/**
 * Removing the Default leaves `defaultIndex` at -1 rather than silently
 * promoting a neighbour: the operator picks the replacement (ADR-0036).
 */
export function removeVariant(draft: FlagDraft, index: number): FlagDraft {
  const variants = draft.variants.filter((_, position) => position !== index);
  if (index === draft.defaultIndex) return { ...draft, variants, defaultIndex: -1 };
  return {
    ...draft,
    variants,
    defaultIndex: draft.defaultIndex > index ? draft.defaultIndex - 1 : draft.defaultIndex,
  };
}

export function draftIssues(draft: FlagDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (draft.key.trim() === "") issues.push({ path: "key", message: "Enter a Flag key." });
  if (draft.variants.length === 0) {
    issues.push({ path: "variants", message: "A Flag needs at least one Variant." });
  }

  const seen = new Map<string, number>();
  draft.variants.forEach((variant, index) => {
    const name = variant.name.trim();
    if (name === "") {
      issues.push({ path: `variants.${index}.name`, message: "Enter a Variant name." });
    } else if (seen.has(name)) {
      issues.push({
        path: `variants.${index}.name`,
        // Allocation is keyed by Variant name, so duplicates are ambiguous.
        message: `"${name}" is already used by Variant ${(seen.get(name) ?? 0) + 1}.`,
      });
    } else {
      seen.set(name, index);
    }

    if (parseVariantValue(variant.value, draft.valueType) === null) {
      issues.push({ path: `variants.${index}.value`, message: valueError(draft.valueType) });
    }
  });

  if (draft.defaultIndex < 0 || draft.defaultIndex >= draft.variants.length) {
    issues.push({ path: "defaultIndex", message: "Choose which Variant is the Default." });
  }
  return issues;
}

export function issueFor(issues: DraftIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

/**
 * Builds the `flags_create` body. Callers must check `draftIssues` first — this
 * throws rather than emitting a payload the contract would reject. The
 * Idempotency Key is the caller's because it identifies one submission of the
 * form, not one rendering of the draft.
 */
export function flagCreateInput(
  appId: string,
  draft: FlagDraft,
  idempotencyKey: string,
): FlagsCreateInput {
  const issues = draftIssues(draft);
  if (issues.length > 0) {
    throw new Error(`create-flag-model: refusing to build an invalid Flag: ${issues[0]?.message}`);
  }

  const key = draft.key.trim();
  return {
    appId,
    key,
    idempotency_key: idempotencyKey,
    name: flagName(key),
    schema: { type: draft.valueType },
    variants: draft.variants.map((variant, index) => ({
      name: variant.name.trim(),
      value: parseVariantValue(variant.value, draft.valueType) as Exclude<
        ReturnType<typeof parseVariantValue>,
        null
      >,
      isDefault: index === draft.defaultIndex,
      ...(variant.description.trim() === "" ? {} : { description: variant.description.trim() }),
    })),
  };
}

export function flagFieldError(
  surface: MutationErrorSurface | null,
  field: string,
): string | undefined {
  if (surface?.kind !== "field") return undefined;
  return surface.fields.find((error) => error.field === field || error.field.endsWith(`.${field}`))
    ?.message;
}

/** `null` means "not a valid value of this type" — the single parse seam. */
function parseVariantValue(
  raw: string,
  valueType: VariantValueType,
): boolean | string | number | Record<string, unknown> | null {
  if (valueType === "string") return raw === "" ? null : raw;

  const text = raw.trim();
  if (text === "") return null;
  if (valueType === "boolean") return parseBoolean(text);
  if (valueType === "number") return parseNumber(text);
  return parseJsonObject(text);
}

function parseBoolean(text: string): boolean | null {
  if (text === "true") return true;
  return text === "false" ? false : null;
}

function parseNumber(text: string): number | null {
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function valueError(valueType: VariantValueType): string {
  if (valueType === "boolean") return "Enter true or false.";
  if (valueType === "number") return "Enter a number.";
  if (valueType === "object") return "Enter a JSON object.";
  return "Enter a value.";
}

function reindexDefault(defaultIndex: number, from: number, to: number): number {
  if (defaultIndex === from) return to;
  if (from < defaultIndex && to >= defaultIndex) return defaultIndex - 1;
  if (from > defaultIndex && to <= defaultIndex) return defaultIndex + 1;
  return defaultIndex;
}

function flagName(key: string): string {
  const words = key.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return key;
  return words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}
