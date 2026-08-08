import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exposureClaimFaultCode, rejectClaimStoreFault } from "./exposure-claim-fault";
import {
  ExposureRedemptionClaimHttpError,
  ExposureRedemptionClaimProtocolError,
  ExposureRedemptionClaimTransportError,
} from "./exposure-redemption-claim-errors";

const INNER_CAUSE = "Network connection lost: durable object 7f3a stub reset";
const SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/spec/sdk/exposures-endpoint.md",
);

describe("exposureClaimFaultCode classification (mutation-proven)", () => {
  it("classifies transport, protocol, 4xx, and 5xx", () => {
    expect(exposureClaimFaultCode(new TypeError("undefined is not a function"))).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(
      exposureClaimFaultCode(
        new ExposureRedemptionClaimProtocolError(
          "exposure redemption claim returned an invalid outcome",
        ),
      ),
    ).toBe("INTERNAL_SERVER_ERROR");
    expect(exposureClaimFaultCode(new ExposureRedemptionClaimHttpError(400))).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(exposureClaimFaultCode(new ExposureRedemptionClaimHttpError(404))).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(exposureClaimFaultCode(new ExposureRedemptionClaimHttpError(409))).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(exposureClaimFaultCode(new ExposureRedemptionClaimHttpError(500))).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(
      exposureClaimFaultCode(new ExposureRedemptionClaimTransportError(new Error(INNER_CAUSE))),
    ).toBe("SERVICE_UNAVAILABLE");
  });

  it("never quietly buckets an unclassified throw as retryable", () => {
    expect(exposureClaimFaultCode(new Error("something unexpected"))).toBe("INTERNAL_SERVER_ERROR");
    expect(exposureClaimFaultCode("plain string")).toBe("INTERNAL_SERVER_ERROR");
  });

  it("rejectClaimStoreFault is the only rejection shape from the seam", () => {
    expect(rejectClaimStoreFault("e1", new ExposureRedemptionClaimHttpError(409))).toEqual({
      exposureId: "e1",
      status: "rejected",
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(
      rejectClaimStoreFault(
        "e1",
        new ExposureRedemptionClaimTransportError(new Error(INNER_CAUSE)),
      ),
    ).toEqual({ exposureId: "e1", status: "rejected", code: "SERVICE_UNAVAILABLE" });
  });
});

describe("exposures-endpoint.md taxonomy pin", () => {
  it("names both classes and which the SDK retries", () => {
    const spec = readFileSync(SPEC_PATH, "utf8");
    expect(spec).toContain("`SERVICE_UNAVAILABLE`");
    expect(spec).toContain("`INTERNAL_SERVER_ERROR`");
    expect(spec).toMatch(/Transient[\s\S]*SERVICE_UNAVAILABLE[\s\S]*Retain the item and retry/);
    expect(spec).toMatch(/Deterministic[\s\S]*INTERNAL_SERVER_ERROR[\s\S]*drop — never re-queue/);
    expect(spec).toContain("Durable Object transport failure");
    expect(spec).toContain("5xx HTTP");
    expect(spec).toContain("4xx HTTP");
    expect(spec).toContain("parseClaimOutcome");
    expect(spec).toContain("parseAcknowledgeOutcome");
    expect(spec).toContain("400 / 404 / 409");
  });
});
