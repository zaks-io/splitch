import { z } from "@hono/zod-openapi";
import { validateNumericDomain, validatePropertyNames } from "./event-definition-validation";

export const eventDefinitionFamilies = ["metric", "web"] as const;
export const EventDefinitionFamilySchema = z.enum(eventDefinitionFamilies);
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

const BooleanDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("boolean"),
    required: z.boolean(),
    allowedValues: z.array(z.boolean()).min(1).max(2).refine(unique).optional(),
  })
  .strict();

const StringDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("string"),
    required: z.boolean(),
    allowedValues: z.array(TelemetryTokenSchema).min(1).max(256).refine(unique),
  })
  .strict();

const NumberDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("number"),
    required: z.boolean(),
    numberKind: NumberKindSchema,
    allowedValues: z.array(finiteNumber).min(1).max(256).refine(unique).optional(),
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

export const ClosedJsonSchemaSchema: z.ZodType<ClosedJsonSchema> = z
  .lazy(() =>
    z
      .union([
        z
          .object({
            type: z.literal("object"),
            properties: z.record(z.string(), ClosedJsonSchemaSchema),
            required: z.array(z.string()).refine(unique).optional(),
            additionalProperties: z.literal(false),
          })
          .strict()
          .superRefine((value, context) => {
            for (const required of value.required ?? []) {
              if (!(required in value.properties)) {
                context.addIssue({
                  code: "custom",
                  path: ["required"],
                  message: `required property "${required}" is not declared`,
                });
              }
            }
            validatePropertyNames(Object.keys(value.properties), context, ["properties"]);
          }),
        z
          .object({
            type: z.literal("array"),
            items: ClosedJsonSchemaSchema,
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
          }),
        z
          .object({
            type: z.literal("string"),
            enum: z.array(TelemetryTokenSchema).min(1).max(256).refine(unique),
          })
          .strict(),
        z
          .object({
            type: z.enum(["number", "integer"]),
            numberKind: NumberKindSchema,
            enum: z.array(finiteNumber).min(1).max(256).refine(unique).optional(),
            minimum: finiteNumber.optional(),
            maximum: finiteNumber.optional(),
          })
          .strict()
          .superRefine((value, context) =>
            validateNumericDomain({ ...value, allowedValues: value.enum }, context),
          ),
        z
          .object({
            type: z.literal("boolean"),
            enum: z.array(z.boolean()).min(1).max(2).refine(unique).optional(),
          })
          .strict(),
        z.object({ type: z.literal("null") }).strict(),
      ])
      .superRefine((value, context) => {
        if (value.type === "integer" && value.enum?.some((item) => !Number.isInteger(item))) {
          context.addIssue({
            code: "custom",
            path: ["enum"],
            message: "integer enum values must be integers",
          });
        }
      }),
  )
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

export const CreateEventDefinitionRequestSchema = z
  .object({
    name: TelemetryTokenSchema,
    family: EventDefinitionFamilySchema,
    displayName: z.string().min(1),
    description: z.string().optional(),
    idempotency_key: z.string().optional(),
  })
  .strict();

export const PatchEventDefinitionRequestSchema = z
  .object({ displayName: z.string().min(1).optional(), description: z.string().optional() })
  .strict();

export const PublishEventDefinitionVersionRequestSchema = z
  .object({
    entityType: z.string().min(1).nullable(),
    fields: z.array(EventFieldDefinitionSchema),
    dimensions: z.array(ScalarDefinitionSchema),
    idempotency_key: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const fieldNames = value.fields.map(({ name }) => name);
    const dimensionNames = value.dimensions.map(({ name }) => name);
    validatePropertyNames([...fieldNames, ...dimensionNames], context, []);
    if (!unique(fieldNames)) {
      context.addIssue({ code: "custom", path: ["fields"], message: "field names must be unique" });
    }
    if (!unique(dimensionNames)) {
      context.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: "Dimension names must be unique",
      });
    }
    const dimensions = new Set(dimensionNames);
    if (fieldNames.some((name) => dimensions.has(name))) {
      context.addIssue({ code: "custom", message: "field and Dimension names must be disjoint" });
    }
  });

export const EventDefinitionDetailSchema = EventDefinitionSchema.extend({
  versions: z.array(EventDefinitionVersionSchema),
});
export const EventDefinitionListResponseSchema = z.object({
  items: z.array(EventDefinitionSchema),
});
export const EventDefinitionVersionListResponseSchema = z.object({
  items: z.array(EventDefinitionVersionSchema),
});

export const EventDefinitionHotConfigSchema = z
  .object({
    eventDefinition: EventDefinitionSchema,
    version: EventDefinitionVersionSchema,
  })
  .strict();

export type ClosedJson = z.infer<typeof ClosedJsonSchemaSchema>;
export type EventDefinition = z.infer<typeof EventDefinitionSchema>;
export type EventDefinitionVersion = z.infer<typeof EventDefinitionVersionSchema>;
