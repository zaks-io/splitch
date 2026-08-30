import { deriveSlug, SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from "@splitch/contracts";
import type { FlagsCreateInput } from "@splitch/contracts/route-types";
import { z } from "zod";
import type { MutationErrorSurface } from "#lib/shared/api";
import {
  draftConformanceSchema,
  draftFlagSchema,
  flagSchemaIssues,
  parseJsonRecord,
  variantSchemaIssue,
} from "#lib/flags/create-flag-schema";

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
  name: z.string(),
  key: z.string(),
  valueType: z.enum(VARIANT_VALUE_TYPES),
  /** Raw editor text for the optional Flag-level JSON Schema (object Flags only). */
  schemaText: z.string(),
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
    name: "",
    key: "",
    valueType: "boolean",
    schemaText: "",
    variants: [
      { name: "disabled", value: "false", description: "" },
      { name: "enabled", value: "true", description: "" },
    ],
    defaultIndex: 0,
  };
}

/** Suggests a key from the name, and only until the user edits the key themselves. */
export function suggestFlagKey(name: string): string {
  return deriveSlug(name) ?? "";
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

/** True when the drafted JSON Schema cannot survive the switch (only object Flags carry one). */
export function typeSwitchClearsSchema(draft: FlagDraft, nextType: VariantValueType): boolean {
  return draft.valueType === "object" && nextType !== "object" && draft.schemaText.trim() !== "";
}

export function switchValueType(draft: FlagDraft, valueType: VariantValueType): FlagDraft {
  if (valueType === draft.valueType) return draft;
  const schemaText = valueType === "object" ? draft.schemaText : "";
  if (!typeSwitchClearsValues(draft.variants, valueType)) {
    return { ...draft, valueType, schemaText };
  }

  const variants = seedForValueType(valueType);
  return {
    ...draft,
    valueType,
    schemaText,
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
  if (draft.name.trim() === "") issues.push({ path: "name", message: "Give the Flag a name." });
  issues.push(...keyIssues(draft.key.trim()));
  issues.push(...flagSchemaIssues(draft.valueType, draft.schemaText));
  if (draft.variants.length === 0) {
    issues.push({ path: "variants", message: "A Flag needs at least one Variant." });
  }

  const conformance = draftConformanceSchema(draft.valueType, draft.schemaText);
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

    const value = parseVariantValue(variant.value, draft.valueType);
    if (value === null) {
      issues.push({ path: `variants.${index}.value`, message: valueError(draft.valueType) });
    } else if (conformance) {
      const violation = variantSchemaIssue(conformance, value);
      if (violation) issues.push({ path: `variants.${index}.value`, message: violation });
    }
  });

  if (draft.defaultIndex < 0 || draft.defaultIndex >= draft.variants.length) {
    issues.push({ path: "defaultIndex", message: "Choose which Variant is the Default." });
  }
  return issues;
}

/**
 * Client-side parity with the contract's `SlugSchema` on `key`, so the same
 * handle the Worker would reject is named before a round trip. The Worker stays
 * authoritative: this only ever refuses, it never rewrites what the user typed.
 */
function keyIssues(key: string): DraftIssue[] {
  if (key === "") return [{ path: "key", message: "Enter a Flag key." }];
  if (key.length < SLUG_MIN_LENGTH) {
    return [{ path: "key", message: `Use at least ${SLUG_MIN_LENGTH} characters.` }];
  }
  if (key.length > SLUG_MAX_LENGTH) {
    return [{ path: "key", message: `Use at most ${SLUG_MAX_LENGTH} characters.` }];
  }
  if (!SLUG_PATTERN.test(key)) {
    return [
      {
        path: "key",
        message: "Use lowercase letters, digits, and single hyphens, e.g. new-checkout.",
      },
    ];
  }
  return [];
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

  const schema = draftFlagSchema(draft.valueType, draft.schemaText);
  if (schema === null) {
    throw new Error("create-flag-model: draftIssues passed but the Flag schema failed to build");
  }

  return {
    appId,
    key: draft.key.trim(),
    idempotency_key: idempotencyKey,
    name: draft.name.trim(),
    schema,
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
  return parseJsonRecord(text);
}

function parseBoolean(text: string): boolean | null {
  if (text === "true") return true;
  return text === "false" ? false : null;
}

function parseNumber(text: string): number | null {
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
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
