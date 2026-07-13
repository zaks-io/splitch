import { describe, expect, it } from "vitest";
import { isContainerKey, isLeafPiiKey, isPiiKey, REDACTED } from "./redaction-rules";

describe("redaction key policy", () => {
  it("exports the canonical redaction placeholder", () => {
    expect(REDACTED).toBe("[Redacted]");
  });

  it("recognizes PII container keys case-insensitively", () => {
    for (const key of ["targeting", "Targeting", "context", "Context", "evaluationContext"]) {
      expect(isContainerKey(key)).toBe(true);
      expect(isPiiKey(key)).toBe(true);
    }
  });

  it("recognizes separator variants for common PII leaf keys", () => {
    for (const key of ["ipAddress", "ip_address", "ip-address"]) {
      expect(isLeafPiiKey(key)).toBe(true);
      expect(isPiiKey(key)).toBe(true);
    }
  });

  it("recognizes mandated and common PII leaf keys", () => {
    for (const key of [
      "targetingKey",
      "email",
      "phone",
      "phone-number",
      "firstName",
      "last-name",
      "full_name",
      "name",
      "username",
      "address",
      "ssn",
    ]) {
      expect(isLeafPiiKey(key)).toBe(true);
      expect(isPiiKey(key)).toBe(true);
    }
  });

  it("recognizes credential-bearing leaf keys", () => {
    for (const key of [
      "authorization",
      "cookie",
      "password",
      "secret",
      "client_secret",
      "api-key",
      "token",
      "accessToken",
      "refresh_token",
    ]) {
      expect(isLeafPiiKey(key)).toBe(true);
      expect(isPiiKey(key)).toBe(true);
    }
  });

  it("does not treat safe operational keys as PII", () => {
    for (const key of ["appId", "orgId", "role", "variant", "flagKey", "userId"]) {
      expect(isContainerKey(key)).toBe(false);
      expect(isLeafPiiKey(key)).toBe(false);
      expect(isPiiKey(key)).toBe(false);
    }
  });
});
