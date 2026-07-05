import { describe, expect, it } from "vitest";
import { ErrorCodeSchema } from "./errors";
import { ResolutionDetailsSchema } from "./leaf-schemas-runtime";
import {
  DataPlaneEvaluateResponseSchema as SdkDataPlaneEvaluateResponseSchema,
  ErrorCodeSchema as SdkErrorCodeSchema,
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

  it("re-exports the canonical ErrorCode schema", () => {
    expect(SdkErrorCodeSchema).toBe(ErrorCodeSchema);
  });
});
