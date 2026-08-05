import { describe, expect, it } from "vitest";
import { ResolutionDetailsSchema } from "./generated/contract-surface.js";
import { errorCodeForStatus, synthesizeDetails } from "./resolution";
import type { TransportResult } from "./transport";

const DEFAULT_VALUE = "control";

function result(partial: Partial<TransportResult>): TransportResult {
  return { status: 200, variant: null, variantName: null, runId: "run-1", ...partial };
}

describe("synthesizeDetails: 200 success rows", () => {
  it("200 with a resolved variant -> SPLIT + unwrapped variant + the wire arm name", () => {
    const details = synthesizeDetails(
      result({ variant: "treatment", variantName: "treatment-arm" }),
      DEFAULT_VALUE,
    );
    expect(details.reason).toBe("SPLIT");
    expect(details.value).toBe("treatment");
    // The arm label comes off the wire, not from the value: the two differ here
    // precisely because the name is not derivable from the resolved value.
    expect(details.variantName).toBe("treatment-arm");
    expect(details.errorCode).toBeUndefined();
    expect(ResolutionDetailsSchema.safeParse(details).success).toBe(true);
  });

  it("200 with no matched variant (null) -> DEFAULT + Default Variant value", () => {
    const details = synthesizeDetails(result({ variant: null }), DEFAULT_VALUE);
    expect(details.reason).toBe("DEFAULT");
    expect(details.value).toBe(DEFAULT_VALUE);
    // No arm matched, so no arm name — the value is the caller's default.
    expect(details.variantName).toBeNull();
    expect(details.errorCode).toBeUndefined();
  });

  it("unwraps a JsonObject variant value as-is", () => {
    const obj = { color: "blue", count: 3 };
    const details = synthesizeDetails(result({ variant: obj }), DEFAULT_VALUE);
    expect(details.reason).toBe("SPLIT");
    expect(details.value).toEqual(obj);
  });
});

describe("synthesizeDetails: canonical HTTP-status -> reason/errorCode mapping", () => {
  // Each row maps an HTTP status to the WIRE ErrorCode the contract validates
  // (public-evaluate-endpoint.md §"Error responses"; see resolution.ts for the
  // OpenFeature-vs-wire drift note). Local transport failures use SDK_TRANSPORT_*
  // codes set by the transport — not this status table.
  const rows: { status: number; errorCode: string }[] = [
    { status: 401, errorCode: "UNAUTHORIZED" },
    { status: 403, errorCode: "FORBIDDEN" },
    { status: 404, errorCode: "FLAG_NOT_FOUND" },
    { status: 400, errorCode: "VALIDATION_ERROR" },
    { status: 429, errorCode: "RATE_LIMITED" },
    { status: 503, errorCode: "SERVICE_UNAVAILABLE" },
  ];

  for (const row of rows) {
    it(`status ${row.status} -> ERROR + Default Variant + errorCode ${row.errorCode}`, () => {
      const details = synthesizeDetails(result({ status: row.status }), DEFAULT_VALUE);
      expect(details.reason).toBe("ERROR");
      expect(details.value).toBe(DEFAULT_VALUE);
      expect(details.errorCode).toBe(row.errorCode);
      expect(details.errorMessage).toBeTypeOf("string");
      expect(errorCodeForStatus(row.status)).toBe(row.errorCode);
      // The synthesized shape must satisfy the merged contract (fail-loud: an
      // errorCode the contract rejects would throw here).
      expect(ResolutionDetailsSchema.safeParse(details).success).toBe(true);
    });
  }

  it("an unexpected status (e.g. 500) folds to SERVICE_UNAVAILABLE", () => {
    expect(errorCodeForStatus(500)).toBe("SERVICE_UNAVAILABLE");
  });

  it("status null without a transport code falls back to SDK_TRANSPORT_NETWORK, not SERVICE_UNAVAILABLE", () => {
    expect(errorCodeForStatus(null)).toBe("SDK_TRANSPORT_NETWORK");
    const details = synthesizeDetails(result({ status: null }), DEFAULT_VALUE);
    expect(details.errorCode).toBe("SDK_TRANSPORT_NETWORK");
    // SDK client codes are outside the wire ResolutionDetailsSchema.
    expect(ResolutionDetailsSchema.safeParse(details).success).toBe(false);
  });

  it("preserves distinct SDK_TRANSPORT_* codes from the transport", () => {
    for (const errorCode of [
      "SDK_TRANSPORT_NETWORK",
      "SDK_TRANSPORT_TIMEOUT",
      "SDK_TRANSPORT_PARSE",
    ] as const) {
      const details = synthesizeDetails(
        result({ status: null, errorCode, errorMessage: `${errorCode} detail` }),
        DEFAULT_VALUE,
      );
      expect(details.errorCode).toBe(errorCode);
      expect(details.errorMessage).toBe(`${errorCode} detail`);
    }
  });
});
