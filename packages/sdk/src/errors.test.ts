import { describe, expect, it } from "vitest";
import { resolveErrorDocsUrl, sdkClientErrorCodes, sdkErrorCodes, SplitchSdkError } from "./errors";

describe("SDK actionable error catalog", () => {
  it("extends server ErrorCode values with every SDK-only failure code", () => {
    expect(sdkErrorCodes).toContain("UNAUTHORIZED");
    for (const code of sdkClientErrorCodes) {
      expect(sdkErrorCodes).toContain(code);
    }
  });

  it("formats stable code and remediation without inventing a docs URL", () => {
    const error = new SplitchSdkError({
      code: "SDK_RETRIES_INVALID",
      cause: "Retries were enabled",
      remediation: "Set retries to 0",
    });

    expect(error.code).toBe("SDK_RETRIES_INVALID");
    expect(error.message).toContain("SDK_RETRIES_INVALID");
    expect(error.message).toContain("Remediation:");
    expect(error.docsUrl).toBeUndefined();
    expect(resolveErrorDocsUrl(error.code)).toBeUndefined();
  });
});
