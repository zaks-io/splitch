// Docblocks ship verbatim in dist/index.d.ts; keep them consumer-facing. See generate-contract-surface.mjs.
/**
 * Hand-written structural descriptors for the SDK contract surface, compared
 * against `z.toJSONSchema()` (+ unknown-key policy) of the contracts Zod
 * schemas in `contract-surface-structural.test.ts`. This file is test-only: it
 * is never imported by the validators or the tsup entry, so it never reaches
 * dist.
 *
 * The member lists and key lists come from the generated projection of
 * contracts, so adding an error code needs no edit here. The JSON type nodes
 * are the hand-written half: a contracts field that changes type or
 * optionality fails the structural test until this file is updated to match.
 *
 * `unknownKeys` must match the contracts object policy (`strict` = ZodNever
 * catchall, `strip` = default object, `passthrough` = ZodUnknown catchall).
 * Response *parsers* still strip unrecognized keys at runtime so a server that
 * is ahead of this surface cannot collapse flags to defaults (SPL-325).
 */

import {
  dataPlaneEvaluateRequiredKeys,
  errorCodes,
  evaluateAllEntryRequiredKeys,
  evaluateAllReasons,
  evaluateAllResponseRequiredKeys,
  peekEvaluateRequiredKeys,
  type resolutionDetailsPropertyKeys,
  resolutionDetailsRequiredKeys,
  resolutionReasons,
} from "./generated/contract-surface-members";

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
    required: [...dataPlaneEvaluateRequiredKeys],
    unknownKeys: "strict",
  },
  peekEvaluateResponse: {
    properties: {
      variant: variantValueDescriptor,
    },
    required: [...peekEvaluateRequiredKeys],
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
    } satisfies Record<(typeof resolutionDetailsPropertyKeys)[number], JsonTypeNode>,
    required: [...resolutionDetailsRequiredKeys],
    unknownKeys: "strip",
  },
  evaluateAllEntry: {
    properties: {
      variant: nullableVariantValue,
      variantName: nullableString,
      reason: evaluateAllReasonEnum,
      errorCode: { anyOf: [errorCodeEnum, { type: "null" }] },
      exposureIdentity: nullableString,
      exposureTicket: nullableString,
    },
    required: [...evaluateAllEntryRequiredKeys],
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
            exposureIdentity: nullableString,
            exposureTicket: nullableString,
          },
          required: [...evaluateAllEntryRequiredKeys],
          additionalProperties: false,
        },
      },
    },
    required: [...evaluateAllResponseRequiredKeys],
    unknownKeys: "strict",
  },
};
