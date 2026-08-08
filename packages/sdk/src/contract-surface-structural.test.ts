import { describe, expect, it } from "vitest";
import { errorCodes as contractErrorCodes } from "../../contracts/src/error-code";
import {
  EvaluateAllEntrySchema as ZodEvaluateAllEntrySchema,
  EvaluateAllReasonSchema as ZodEvaluateAllReasonSchema,
} from "../../contracts/src/leaves/evaluate-all-wire";
import { ResolutionReasonSchema as ZodResolutionReasonSchema } from "../../contracts/src/leaves/resolution-reason";
import { VariantValueSchema as ZodVariantValueSchema } from "../../contracts/src/leaves/variant-value";
import {
  DataPlaneEvaluateResponseSchema as ZodDataPlaneEvaluateResponseSchema,
  EvaluateAllResponseSchema as ZodEvaluateAllResponseSchema,
  PeekEvaluateResponseSchema as ZodPeekEvaluateResponseSchema,
  ResolutionDetailsSchema as ZodResolutionDetailsSchema,
} from "../../contracts/src/sdk-data-plane-surface";
import { contractSurfaceDescriptors } from "../scripts/contract-surface-descriptors";
import {
  type ZodSchema,
  normalizeTypeNode,
  objectDescriptorFromZod,
  sortedObjectDescriptor,
  z,
} from "./contract-surface-schema-describe";

describe("contract-surface structural descriptors", () => {
  it("errorCodes / reasons / VariantValue match contracts exactly", () => {
    expect([...contractSurfaceDescriptors.errorCodes]).toEqual([...contractErrorCodes]);
    expect([...contractSurfaceDescriptors.resolutionReasons]).toEqual([
      ...ZodResolutionReasonSchema.options,
    ]);
    expect([...contractSurfaceDescriptors.evaluateAllReasons]).toEqual([
      ...ZodEvaluateAllReasonSchema.options,
    ]);
    expect(normalizeTypeNode(contractSurfaceDescriptors.variantValue)).toEqual(
      normalizeTypeNode(z.toJSONSchema(ZodVariantValueSchema)),
    );
  });

  it("object shapes match contracts (properties, required, unknownKeys)", () => {
    expect(sortedObjectDescriptor(contractSurfaceDescriptors.dataPlaneEvaluateResponse)).toEqual(
      objectDescriptorFromZod(ZodDataPlaneEvaluateResponseSchema as ZodSchema),
    );
    expect(sortedObjectDescriptor(contractSurfaceDescriptors.peekEvaluateResponse)).toEqual(
      objectDescriptorFromZod(ZodPeekEvaluateResponseSchema as ZodSchema),
    );
    expect(sortedObjectDescriptor(contractSurfaceDescriptors.resolutionDetails)).toEqual(
      objectDescriptorFromZod(ZodResolutionDetailsSchema as ZodSchema),
    );
    expect(sortedObjectDescriptor(contractSurfaceDescriptors.evaluateAllEntry)).toEqual(
      objectDescriptorFromZod(ZodEvaluateAllEntrySchema as ZodSchema),
    );

    const contractResponse = objectDescriptorFromZod(ZodEvaluateAllResponseSchema as ZodSchema);
    const mirrorResponse = sortedObjectDescriptor(contractSurfaceDescriptors.evaluateAllResponse);
    expect(mirrorResponse.required).toEqual(contractResponse.required);
    expect(mirrorResponse.unknownKeys).toEqual(contractResponse.unknownKeys);
    expect(Object.keys(mirrorResponse.properties).sort()).toEqual(
      Object.keys(contractResponse.properties).sort(),
    );
    const entry = objectDescriptorFromZod(ZodEvaluateAllEntrySchema as ZodSchema);
    const expectedEvaluations = {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: {
        type: "object",
        properties: entry.properties,
        required: entry.required,
        additionalProperties: false,
      },
    };
    expect(normalizeTypeNode(mirrorResponse.properties.evaluations)).toEqual(
      normalizeTypeNode(expectedEvaluations),
    );
    expect(normalizeTypeNode(contractResponse.properties.evaluations)).toEqual(
      normalizeTypeNode(expectedEvaluations),
    );
  });
});
