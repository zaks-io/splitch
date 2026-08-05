import { describe, expect, it } from "vitest";
import { resolveErrorDocsUrl, sdkClientErrorCodes, sdkErrorCodes, SplitchSdkError } from "./errors";

describe("SDK actionable error catalog", () => {
  it("extends server ErrorCode values with every SDK-only failure code", () => {
    expect(sdkErrorCodes).toContain("UNAUTHORIZED");
    for (const code of sdkClientErrorCodes) {
      expect(sdkErrorCodes).toContain(code);
    }
  });

  it("formats stable code, remediation, and the per-code docs URL", () => {
    const original = new Error("configuration source failed");
    const error = new SplitchSdkError({
      code: "SDK_RETRIES_INVALID",
      causeSummary: "Retries were enabled",
      remediation: "Set retries to 0",
      originalError: original,
    });

    expect(error.code).toBe("SDK_RETRIES_INVALID");
    expect(error.message).toContain("SDK_RETRIES_INVALID");
    expect(error.message).toContain("Remediation:");
    expect(error.docsUrl).toBe("https://splitch.dev/docs/error/SDK_RETRIES_INVALID");
    expect(error.message).toContain(error.docsUrl);
    expect(error.cause).toBe(original);
  });

  it("resolves a docs URL for every code the SDK can raise", () => {
    for (const code of sdkErrorCodes) {
      expect(resolveErrorDocsUrl(code)).toBe(`https://splitch.dev/docs/error/${code}`);
    }
  });
});
