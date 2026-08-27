import { CreateFlagRequestSchema } from "@splitch/sdk/control-plane";
import { SplitchCliError } from "./errors.js";

const BOOLEAN_VARIANT_ALIASES: Readonly<Record<string, boolean>> = {
  on: true,
  off: false,
  true: true,
  false: false,
  enabled: true,
  disabled: false,
};

const FALSE_VARIANT_ALIASES = new Set(["off", "false", "disabled"]);

export interface CliInputErrorPayload {
  readonly code: "CLI_VALIDATION_ERROR";
  readonly message: string;
  readonly details: {
    readonly field: string;
    readonly reason: string;
  };
}

export class CliInputError extends SplitchCliError {
  readonly payload: CliInputErrorPayload;

  constructor(payload: CliInputErrorPayload, remediation?: string) {
    super({
      code: payload.code,
      causeSummary: payload.message,
      remediation: remediation ?? "Correct the named input field and run the command again",
    });
    this.name = "CliInputError";
    this.payload = payload;
  }
}

export interface BooleanVariantCatalogEntry {
  readonly name: string;
  readonly value: boolean;
  readonly isDefault: boolean;
}

export function flagNameFromKey(key: string): string {
  const words = key.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) {
    return key;
  }
  return words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

export function parseBooleanVariantsFlag(variantsFlag: string): BooleanVariantCatalogEntry[] {
  const names = parseVariantNames(variantsFlag);
  assertUniqueVariantNames(names);
  const entries = names.map((name) => ({
    name,
    value: readBooleanVariantValue(name),
  }));
  assertUniqueBooleanValues(entries);
  const defaultName = resolveDefaultVariantName(entries);
  return entries.map((entry) => ({
    ...entry,
    isDefault: entry.name === defaultName,
  }));
}

function parseVariantNames(variantsFlag: string): string[] {
  const names = variantsFlag
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.length === 0) {
    throw variantInputError(
      "splitch flags create --variants requires at least one Variant name",
      "empty_variant_list",
    );
  }

  return names;
}

function assertUniqueVariantNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw variantInputError(
        `splitch flags create --variants has duplicate Variant name "${name}"`,
        "duplicate_variant_name",
      );
    }
    seen.add(name);
    if (!(name in BOOLEAN_VARIANT_ALIASES)) {
      throw variantInputError(
        `splitch flags create --variants has unknown boolean Variant "${name}"`,
        "unknown_variant_name",
      );
    }
  }
}

function readBooleanVariantValue(name: string): boolean {
  return BOOLEAN_VARIANT_ALIASES[name] as boolean;
}

function assertUniqueBooleanValues(
  entries: ReadonlyArray<{ readonly name: string; readonly value: boolean }>,
): void {
  const values = new Set(entries.map((entry) => entry.value));
  if (values.size !== entries.length) {
    throw variantInputError(
      "splitch flags create --variants must map to unique boolean values",
      "ambiguous_variant_values",
    );
  }
}

function resolveDefaultVariantName(entries: ReadonlyArray<{ readonly name: string }>): string {
  const falseAliases = entries.filter((entry) => FALSE_VARIANT_ALIASES.has(entry.name));
  const defaultName =
    falseAliases.length === 1
      ? falseAliases[0]?.name
      : entries.length === 1
        ? entries[0]?.name
        : undefined;

  if (!defaultName) {
    throw variantInputError(
      "splitch flags create --variants must include exactly one Default Variant (use off, false, or disabled, or pass a single Variant)",
      "ambiguous_default_variant",
    );
  }

  return defaultName;
}

function variantInputError(message: string, reason: string): CliInputError {
  return new CliInputError({
    code: "CLI_VALIDATION_ERROR",
    message,
    details: { field: "variants", reason },
  });
}

export function applyFlagsCreateConvenienceFields(
  input: Record<string, unknown>,
  options: {
    readonly key?: string;
    readonly name?: string;
    readonly variants?: string;
  },
): void {
  if (options.variants) {
    const key = options.key ?? (typeof input.key === "string" ? input.key : undefined);
    if (!key) {
      throw new CliInputError({
        code: "CLI_VALIDATION_ERROR",
        message: "splitch flags create --variants requires --key",
        details: { field: "key", reason: "missing_key" },
      });
    }

    const trimmedKey = key.trim();
    input.key = trimmedKey;
    input.name =
      options.name ?? (typeof input.name === "string" ? input.name : flagNameFromKey(trimmedKey));
    input.schema = { type: "boolean" };
    input.variants = parseBooleanVariantsFlag(options.variants);
    return;
  }

  if (!Array.isArray(input.variants)) {
    throw new CliInputError({
      code: "CLI_VALIDATION_ERROR",
      message: "splitch flags create requires --variants or --body-json with a variant catalog",
      details: { field: "variants", reason: "missing_variant_catalog" },
    });
  }
}

export function assertContractValidFlagsCreateInput(input: Record<string, unknown>): void {
  const parsed = CreateFlagRequestSchema.safeParse(input);
  if (parsed.success) {
    return;
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "body";
  throw new CliInputError({
    code: "CLI_VALIDATION_ERROR",
    message: `splitch flags create input is invalid: ${issue?.message ?? "validation failed"}`,
    details: { field: path, reason: "contract_validation_failed" },
  });
}
