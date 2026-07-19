import type { FlagsCreateInput } from "@splitch/contracts/route-types";
import type { MutationErrorSurface } from "./api";

export const BOOLEAN_FLAG_VARIANTS = [
  { name: "disabled", value: false, isDefault: true },
  { name: "enabled", value: true, isDefault: false },
] as const;

export function booleanFlagInput(appId: string, rawKey: string): FlagsCreateInput {
  const key = rawKey.trim();
  return {
    appId,
    key,
    name: flagName(key),
    schema: { type: "boolean" },
    variants: BOOLEAN_FLAG_VARIANTS.map((variant) => ({ ...variant })),
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

function flagName(key: string): string {
  const words = key.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return key;
  return words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}
