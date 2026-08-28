import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_SHAPE_MESSAGE,
  IdempotencyKeySchema,
  PERSISTED_ARRAY_MAX_ITEMS,
  PERSISTED_NAME_MAX_LENGTH,
  PERSISTED_RECORD_MAX_KEYS,
  PersistedNameSchema,
  persistedArray,
  persistedRecord,
} from "./persisted-field-limits";
import { requestBodySchemaForOperation } from "./request-body-help";

describe("persisted field limits", () => {
  it("accepts a name at the documented bound and rejects one character over", () => {
    expect(PersistedNameSchema.safeParse("n".repeat(PERSISTED_NAME_MAX_LENGTH)).success).toBe(true);
    expect(PersistedNameSchema.safeParse("n".repeat(PERSISTED_NAME_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it("caps persisted arrays and records at the documented bounds", () => {
    const values = Array.from({ length: PERSISTED_ARRAY_MAX_ITEMS }, (_, index) => `v${index}`);
    expect(persistedArray(PersistedNameSchema).safeParse(values).success).toBe(true);
    expect(persistedArray(PersistedNameSchema).safeParse([...values, "overflow"]).success).toBe(
      false,
    );

    const record = Object.fromEntries(
      Array.from({ length: PERSISTED_RECORD_MAX_KEYS }, (_, index) => [`k${index}`, 1]),
    );
    expect(persistedRecord(PersistedNameSchema).safeParse(record).success).toBe(true);
    expect(persistedRecord(PersistedNameSchema).safeParse({ ...record, overflow: 1 }).success).toBe(
      false,
    );
  });

  it("shares the header idempotency bound and printable-ASCII policy", () => {
    expect(IdempotencyKeySchema.safeParse("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH)).success).toBe(
      true,
    );
    expect(IdempotencyKeySchema.safeParse("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)).success).toBe(
      false,
    );
    expect(IdempotencyKeySchema.safeParse("abc 123").success).toBe(false);
    const spaced = IdempotencyKeySchema.safeParse("abc 123");
    expect(spaced.success).toBe(false);
    if (spaced.success) return;
    expect(spaced.error.issues[0]?.message).toBe(IDEMPOTENCY_KEY_SHAPE_MESSAGE);
  });
});

describe("EntityPrivacyRequestSchema", () => {
  it("rejects an unknown field with the field name in the issue", () => {
    const schema = requestBodySchemaForOperation("entity_privacy_export");
    expect(schema).toBeDefined();
    if (!schema) return;
    const result = schema.safeParse({
      idType: "user",
      targetingKey: "subject",
      extra: true,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["extra"],
    });
  });
});
