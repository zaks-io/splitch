import { describe, expect, it } from "vitest";
import { ErrorCodeSchema } from "./errors";
import { ResolutionDetailsSchema } from "./leaf-schemas-runtime";
import { EvaluateAllRequestSchema, EvaluateAllResponseSchema } from "./leaves/evaluate-all-wire";
import { ExposureBatchRequestSchema, ExposureBatchResponseSchema } from "./leaves/exposures-wire";
import {
  DataPlaneEvaluateResponseSchema as SdkDataPlaneEvaluateResponseSchema,
  ErrorCodeSchema as SdkErrorCodeSchema,
  EvaluateAllRequestSchema as SdkEvaluateAllRequestSchema,
  EvaluateAllResponseSchema as SdkEvaluateAllResponseSchema,
  ExposureBatchRequestSchema as SdkExposureBatchRequestSchema,
  ExposureBatchResponseSchema as SdkExposureBatchResponseSchema,
  PeekEvaluateResponseSchema as SdkPeekEvaluateResponseSchema,
  ResolutionDetailsSchema as SdkResolutionDetailsSchema,
} from "./sdk-data-plane-surface";
import { DataPlaneEvaluateResponseSchema, PeekEvaluateResponseSchema } from "./wire-envelopes-core";

describe("sdk-data-plane-surface parity", () => {
  it("re-exports the canonical ResolutionDetails schema", () => {
    expect(SdkResolutionDetailsSchema).toBe(ResolutionDetailsSchema);
  });

  it("re-exports the canonical data-plane evaluate response schemas", () => {
    expect(SdkDataPlaneEvaluateResponseSchema).toBe(DataPlaneEvaluateResponseSchema);
    expect(SdkPeekEvaluateResponseSchema).toBe(PeekEvaluateResponseSchema);
  });

  it("re-exports the canonical evaluate-all request and response schemas", () => {
    expect(SdkEvaluateAllRequestSchema).toBe(EvaluateAllRequestSchema);
    expect(SdkEvaluateAllResponseSchema).toBe(EvaluateAllResponseSchema);
  });

  it("re-exports the canonical exposures batch request and response schemas", () => {
    expect(SdkExposureBatchRequestSchema).toBe(ExposureBatchRequestSchema);
    expect(SdkExposureBatchResponseSchema).toBe(ExposureBatchResponseSchema);
  });

  it("re-exports the canonical ErrorCode schema", () => {
    expect(SdkErrorCodeSchema).toBe(ErrorCodeSchema);
  });
});
