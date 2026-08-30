import { describe, expect, it } from "vitest";
import { requireVerificationUrl } from "./auth-device-approval.js";
import { SplitchCliError } from "./errors.js";
import { authOriginRequiresHttps } from "./sdks.js";

const hostedAuth = "https://auth.splitch.dev";
const localAuth = "http://127.0.0.1:8789";

describe("device approval URL binding", () => {
  it("accepts WorkOS's hosted AuthKit approval origin", () => {
    expect(
      requireVerificationUrl(
        "https://soulful-path-50.authkit.app/device",
        "verification_uri",
        true,
      ),
    ).toBe("https://soulful-path-50.authkit.app/device");
  });

  it("accepts local HTTP only for an explicit local Auth origin", () => {
    expect(
      requireVerificationUrl(`${localAuth}/device`, "verification_uri", false, localAuth),
    ).toBe("http://127.0.0.1:8789/device");
  });

  it.each([
    ["credential-bearing userinfo", "https://user:pass@auth.splitch.dev/device", true, undefined],
    ["https downgrade", "http://auth.splitch.dev/device", true, undefined],
    ["hosted http", `${localAuth}/device`, true, undefined],
    ["unexpected complete origin", "https://evil.test/device", true, hostedAuth],
    ["local foreign https", "https://auth.splitch.dev/device", false, localAuth],
    ["javascript scheme", "javascript:alert(1)", true, undefined],
    ["file scheme", "file:///tmp/approval", true, undefined],
  ])("rejects a %s device URL without echoing it", (_case, value, requireHttps, expectedOrigin) => {
    try {
      requireVerificationUrl(value, "verification_uri", requireHttps, expectedOrigin);
      expect.unreachable("expected the URL to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitchCliError);
      const failure = error as SplitchCliError;
      expect(failure.code).toBe("CLI_DEVICE_AUTHORIZATION_FAILED");
      expect(failure.message).not.toContain("user:pass");
      expect(failure.message).not.toContain("evil.test");
      expect(failure.causeSummary).toContain("invalid verification_uri");
    }
  });
});

describe("hosted Auth HTTPS requirement", () => {
  it("requires HTTPS on hosted targets and allows HTTP only for local and pr-ci", () => {
    expect(authOriginRequiresHttps({})).toBe(true);
    expect(authOriginRequiresHttps({ platformTarget: "production" })).toBe(true);
    expect(authOriginRequiresHttps({ platformTarget: "shared-preview" })).toBe(true);
    expect(authOriginRequiresHttps({ platformTarget: "local" })).toBe(false);
    expect(authOriginRequiresHttps({ platformTarget: "pr-ci" })).toBe(false);
  });
});
