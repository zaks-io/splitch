import { z } from "zod";

/**
 * Absolute product bounds for values that persist from an external write.
 * These are not data-dependent scales. Existing stored rows are not truncated;
 * over-limit input fails at parse, before D1, KV, or Tinybird writes.
 */

export const PERSISTED_NAME_MAX_LENGTH = 200;
export const PERSISTED_DESCRIPTION_MAX_LENGTH = 2000;
export const PERSISTED_IDENTIFIER_MAX_LENGTH = 128;
export const PERSISTED_CONDITION_ATTRIBUTE_MAX_LENGTH = 128;
export const PERSISTED_CONDITION_VALUE_MAX_LENGTH = 1024;
export const PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH = 4096;
export const PERSISTED_SALT_MAX_LENGTH = 128;
export const PERSISTED_ARRAY_MAX_ITEMS = 100;
export const PERSISTED_RECORD_MAX_KEYS = 64;
export const PERSISTED_RECORD_KEY_MAX_LENGTH = 128;
/** Maximum nesting depth of persisted JSON objects and arrays, including the root. */
export const PERSISTED_JSON_MAX_DEPTH = 8;
/** Maximum UTF-16 code units in a persisted client-key origin URL. */
export const PERSISTED_ORIGIN_MAX_LENGTH = 2048;
/** Maximum items in a telemetry enum / allowlist (named domain bound, not the array product cap). */
export const PERSISTED_TELEMETRY_ENUM_MAX_ITEMS = 256;

export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
/** Printable ASCII excluding space and control characters. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/;
export const IDEMPOTENCY_KEY_SHAPE_MESSAGE =
  "must be 1–255 printable ASCII characters without whitespace";

export const PersistedNameSchema = z.string().min(1).max(PERSISTED_NAME_MAX_LENGTH);
export const PersistedDescriptionSchema = z.string().max(PERSISTED_DESCRIPTION_MAX_LENGTH);
export const PersistedIdentifierSchema = z.string().min(1).max(PERSISTED_IDENTIFIER_MAX_LENGTH);
export const PersistedConditionAttributeSchema = z
  .string()
  .min(1)
  .max(PERSISTED_CONDITION_ATTRIBUTE_MAX_LENGTH);
export const PersistedConditionValueStringSchema = z
  .string()
  .max(PERSISTED_CONDITION_VALUE_MAX_LENGTH);
export const PersistedVariantValueStringSchema = z
  .string()
  .max(PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH);
export const PersistedSaltSchema = z.string().min(1).max(PERSISTED_SALT_MAX_LENGTH);

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN, IDEMPOTENCY_KEY_SHAPE_MESSAGE);

export function persistedArray<Schema extends z.ZodType>(schema: Schema) {
  return z.array(schema).max(PERSISTED_ARRAY_MAX_ITEMS);
}

export function persistedRecord<Value extends z.ZodType>(valueSchema: Value) {
  return z
    .record(z.string().max(PERSISTED_RECORD_KEY_MAX_LENGTH), valueSchema)
    .superRefine((value, context) => {
      if (Object.keys(value).length > PERSISTED_RECORD_MAX_KEYS) {
        context.addIssue({
          code: "custom",
          message: `must contain at most ${PERSISTED_RECORD_MAX_KEYS} keys`,
        });
      }
    });
}
