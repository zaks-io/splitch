import { z } from "@hono/zod-openapi";
import { validateNumericDomain, validatePropertyNames } from "./event-definition-validation";
import { PERSISTED_TELEMETRY_ENUM_MAX_ITEMS } from "./persisted-field-limits";
import { OWN_PROTO_KEY_MESSAGE, protoSafeRecord } from "./proto-safe-record";
import { listResponse } from "./wire-envelopes-core";

export const eventDefinitionFamilies = ["metric", "web"] as const;
export const EventDefinitionFamilySchema = z.enum(eventDefinitionFamilies);
export const eventDefinitionStates = ["draft", "incomplete", "published"] as const;
export const EventDefinitionStateSchema = z.enum(eventDefinitionStates);
export const numberKinds = [
  "measurement",
  "count",
  "amount",
  "duration",
  "ratio",
  "score",
  "delta",
] as const;
export const NumberKindSchema = z.enum(numberKinds);

export const TelemetryTokenSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const finiteNumber = z.number().finite();
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

export const BooleanDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("boolean"),
    required: z.boolean(),
    allowedValues: z.array(z.boolean()).min(1).max(2).refine(unique).optional(),
  })
  .strict();

export const StringDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("string"),
    required: z.boolean(),
    allowedValues: z
      .array(TelemetryTokenSchema)
      .min(1)
      .max(PERSISTED_TELEMETRY_ENUM_MAX_ITEMS)
      .refine(unique),
  })
  .strict();

export const NumberDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("number"),
    required: z.boolean(),
    numberKind: NumberKindSchema,
    allowedValues: z
      .array(finiteNumber)
      .min(1)
      .max(PERSISTED_TELEMETRY_ENUM_MAX_ITEMS)
      .refine(unique)
      .optional(),
    minimum: finiteNumber.optional(),
    maximum: finiteNumber.optional(),
  })
  .strict()
  .superRefine((value, context) => validateNumericDomain(value, context));

type ClosedJsonSchema =
  | {
      type: "object";
      properties: Record<string, ClosedJsonSchema>;
      required?: string[];
      additionalProperties: false;
    }
  | { type: "array"; items: ClosedJsonSchema; minItems?: number; maxItems?: number }
  | { type: "string"; enum: string[] }
  | {
      type: "number" | "integer";
      numberKind: z.infer<typeof NumberKindSchema>;
      enum?: number[];
      minimum?: number;
      maximum?: number;
    }
  | { type: "boolean"; enum?: boolean[] }
  | { type: "null" };

const ClosedJsonStringSchema = z
  .object({
    type: z.literal("string"),
    enum: z
      .array(TelemetryTokenSchema)
      .min(1)
      .max(PERSISTED_TELEMETRY_ENUM_MAX_ITEMS)
      .refine(unique),
  })
  .strict();

const ClosedJsonNumberSchema = z
  .object({
    type: z.enum(["number", "integer"]),
    numberKind: NumberKindSchema,
    enum: z
      .array(finiteNumber)
      .min(1)
      .max(PERSISTED_TELEMETRY_ENUM_MAX_ITEMS)
      .refine(unique)
      .optional(),
    minimum: finiteNumber.optional(),
    maximum: finiteNumber.optional(),
  })
  .strict()
  .superRefine((value, context) =>
    validateNumericDomain({ ...value, allowedValues: value.enum }, context),
  );

const ClosedJsonBooleanSchema = z
  .object({
    type: z.literal("boolean"),
    enum: z.array(z.boolean()).min(1).max(2).refine(unique).optional(),
  })
  .strict();

const ClosedJsonNullSchema = z.object({ type: z.literal("null") }).strict();

function refineClosedJsonIntegerEnum(value: ClosedJsonSchema, context: z.RefinementCtx): void {
  if (value.type === "integer" && value.enum?.some((item) => !Number.isInteger(item))) {
    context.addIssue({
      code: "custom",
      path: ["enum"],
      message: "integer enum values must be integers",
    });
  }
}

function closedJsonObjectSchema(nested: z.ZodType<ClosedJsonSchema>) {
  return z
    .object({
      type: z.literal("object"),
      properties: protoSafeRecord(nested, OWN_PROTO_KEY_MESSAGE),
      required: z.array(z.string()).refine(unique).optional(),
      additionalProperties: z.literal(false),
    })
    .strict()
    .superRefine((value, context) => {
      for (const required of value.required ?? []) {
        if (!Object.hasOwn(value.properties, required)) {
          context.addIssue({
            code: "custom",
            path: ["required"],
            message: `required property "${required}" is not declared`,
          });
        }
      }
      validatePropertyNames(Object.keys(value.properties), context, ["properties"]);
    });
}

function closedJsonArraySchema(nested: z.ZodType<ClosedJsonSchema>) {
  return z
    .object({
      type: z.literal("array"),
      items: nested,
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.minItems !== undefined &&
        value.maxItems !== undefined &&
        value.minItems > value.maxItems
      ) {
        context.addIssue({ code: "custom", message: "minItems must not exceed maxItems" });
      }
    });
}

function closedJsonLeafUnion(): z.ZodType<ClosedJsonSchema> {
  return z
    .discriminatedUnion("type", [
      ClosedJsonStringSchema,
      ClosedJsonNumberSchema,
      ClosedJsonBooleanSchema,
      ClosedJsonNullSchema,
    ])
    .superRefine(refineClosedJsonIntegerEnum);
}

function closedJsonSchemaUnion(nested: z.ZodType<ClosedJsonSchema>): z.ZodType<ClosedJsonSchema> {
  return z
    .discriminatedUnion("type", [
      closedJsonObjectSchema(nested),
      closedJsonArraySchema(nested),
      ClosedJsonStringSchema,
      ClosedJsonNumberSchema,
      ClosedJsonBooleanSchema,
      ClosedJsonNullSchema,
    ])
    .superRefine(refineClosedJsonIntegerEnum);
}

/**
 * Finite write-depth Closed JSON. Depth 1 is leaves only, so a 2000-deep
 * document fails at the named bound without walking the leftover tree or
 * using a preprocess/transform that derived CLI/MCP schemas cannot represent.
 */
export function closedJsonSchemaAtDepth(remainingDepth: number): z.ZodType<ClosedJsonSchema> {
  if (remainingDepth <= 1) {
    return closedJsonLeafUnion();
  }
  return closedJsonSchemaUnion(closedJsonSchemaAtDepth(remainingDepth - 1));
}

export const ClosedJsonSchemaSchema: z.ZodType<ClosedJsonSchema> = z
  .lazy(() => closedJsonSchemaUnion(ClosedJsonSchemaSchema))
  .openapi({ type: "object" });

const JsonFieldDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("json"),
    required: z.boolean(),
    jsonSchema: ClosedJsonSchemaSchema,
  })
  .strict();

export const ScalarDefinitionSchema = z.discriminatedUnion("type", [
  BooleanDefinitionSchema,
  StringDefinitionSchema,
  NumberDefinitionSchema,
]);
export const EventFieldDefinitionSchema = z.discriminatedUnion("type", [
  BooleanDefinitionSchema,
  StringDefinitionSchema,
  NumberDefinitionSchema,
  JsonFieldDefinitionSchema,
]);

export const EventDefinitionSchema = z
  .object({
    id: z.string(),
    appId: z.string(),
    name: TelemetryTokenSchema,
    family: EventDefinitionFamilySchema,
    displayName: z.string().min(1),
    description: z.string().optional(),
    state: EventDefinitionStateSchema,
    currentPublishedVersionId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const EventDefinitionVersionSchema = z
  .object({
    id: z.string(),
    eventDefinitionId: z.string(),
    version: z.number().int().positive(),
    schemaHash: z.string(),
    entityType: z.string().min(1).nullable(),
    fields: z.array(EventFieldDefinitionSchema),
    dimensions: z.array(ScalarDefinitionSchema),
    publishedAt: z.string(),
  })
  .strict();

export const EventDefinitionDetailSchema = EventDefinitionSchema.extend({
  versions: z.array(EventDefinitionVersionSchema),
});
export const EventDefinitionListResponseSchema = listResponse(EventDefinitionSchema);
export const EventDefinitionVersionListResponseSchema = listResponse(EventDefinitionVersionSchema);

export const EventDefinitionHotConfigSchema = z
  .object({
    eventDefinition: EventDefinitionSchema,
    version: EventDefinitionVersionSchema,
  })
  .strict();

export type ClosedJson = z.infer<typeof ClosedJsonSchemaSchema>;
export type EventFieldDefinition = z.infer<typeof EventFieldDefinitionSchema>;
export type EventDefinition = z.infer<typeof EventDefinitionSchema>;
export type EventDefinitionVersion = z.infer<typeof EventDefinitionVersionSchema>;
