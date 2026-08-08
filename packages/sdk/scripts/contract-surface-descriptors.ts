/**
 * Hand-maintained structural descriptors for the SDK contract-surface mirrors.
 * Compared against `z.toJSONSchema()` (+ unknown-key policy) of the contracts
 * Zod schemas in `contract-surface-structural.test.ts`. Nothing generates these.
 *
 * `unknownKeys` must match the contracts object policy (`strict` = ZodNever
 * catchall, `strip` = default object, `passthrough` = ZodUnknown catchall).
 * Response *parsers* still strip unrecognized keys at runtime so a server that
 * is ahead of this mirror cannot collapse flags to defaults (SPL-325).
 */

import { errorCodes, evaluateAllReasons, resolutionReasons } from "./contract-surface-enums";
import {
  dataPlaneEvaluateKeys,
  evaluateAllEntryKeys,
  evaluateAllResponseKeys,
  peekEvaluateKeys,
  resolutionDetailsKeys,
} from "./contract-surface-keys";

export type UnknownKeysPolicy = "strict" | "strip" | "passthrough";

export type JsonTypeNode =
  | { type: "boolean" }
  | { type: "string" }
  | { type: "number" }
  | { type: "null" }
  | {
      type: "object";
      propertyNames?: { type: "string" };
      additionalProperties: unknown;
    }
  | { type: "array"; items?: unknown }
  | { anyOf: JsonTypeNode[] }
  | { type: "string"; enum: readonly string[] };

export interface ObjectShapeDescriptor {
  readonly properties: Readonly<Record<string, JsonTypeNode>>;
  readonly required: readonly string[];
  readonly unknownKeys: UnknownKeysPolicy;
}

export interface ContractSurfaceDescriptors {
  readonly errorCodes: readonly string[];
  readonly resolutionReasons: readonly string[];
  readonly evaluateAllReasons: readonly string[];
  readonly variantValue: JsonTypeNode;
  readonly dataPlaneEvaluateResponse: ObjectShapeDescriptor;
  readonly peekEvaluateResponse: ObjectShapeDescriptor;
  readonly resolutionDetails: ObjectShapeDescriptor;
  readonly evaluateAllEntry: ObjectShapeDescriptor;
  readonly evaluateAllResponse: ObjectShapeDescriptor;
}

const variantValueDescriptor: JsonTypeNode = {
  anyOf: [
    { type: "boolean" },
    { type: "string" },
    { type: "number" },
    {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: {},
    },
  ],
};

const nullableVariantValue: JsonTypeNode = {
  anyOf: [variantValueDescriptor, { type: "null" }],
};

const nullableString: JsonTypeNode = {
  anyOf: [{ type: "string" }, { type: "null" }],
};

const errorCodeEnum: JsonTypeNode = { type: "string", enum: errorCodes };
const resolutionReasonEnum: JsonTypeNode = { type: "string", enum: resolutionReasons };
const evaluateAllReasonEnum: JsonTypeNode = { type: "string", enum: evaluateAllReasons };

export const contractSurfaceDescriptors: ContractSurfaceDescriptors = {
  errorCodes,
  resolutionReasons,
  evaluateAllReasons,
  variantValue: variantValueDescriptor,
  dataPlaneEvaluateResponse: {
    properties: {
      variant: nullableVariantValue,
    },
    required: [...dataPlaneEvaluateKeys],
    unknownKeys: "strict",
  },
  peekEvaluateResponse: {
    properties: {
      variant: variantValueDescriptor,
    },
    required: [...peekEvaluateKeys],
    unknownKeys: "strict",
  },
  resolutionDetails: {
    properties: {
      value: variantValueDescriptor,
      variantName: nullableString,
      reason: resolutionReasonEnum,
      ruleId: { type: "string" },
      errorCode: errorCodeEnum,
      errorMessage: { type: "string" },
    } satisfies Record<(typeof resolutionDetailsKeys)[number], JsonTypeNode>,
    required: ["value", "variantName", "reason"],
    unknownKeys: "strip",
  },
  evaluateAllEntry: {
    properties: {
      variant: nullableVariantValue,
      variantName: nullableString,
      reason: evaluateAllReasonEnum,
      errorCode: { anyOf: [errorCodeEnum, { type: "null" }] },
      exposureTicket: nullableString,
    },
    required: [...evaluateAllEntryKeys],
    unknownKeys: "strict",
  },
  evaluateAllResponse: {
    properties: {
      evaluations: {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: {
          type: "object",
          properties: {
            variant: nullableVariantValue,
            variantName: nullableString,
            reason: evaluateAllReasonEnum,
            errorCode: { anyOf: [errorCodeEnum, { type: "null" }] },
            exposureTicket: nullableString,
          },
          required: [...evaluateAllEntryKeys],
          additionalProperties: false,
        },
      },
    },
    required: [...evaluateAllResponseKeys],
    unknownKeys: "strict",
  },
};
