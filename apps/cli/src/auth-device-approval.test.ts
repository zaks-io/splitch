import { describe, expect, it } from "vitest";
import { requireVerificationUrl } from "./auth-device-approval.js";
import { SplitchCliError } from "./errors.js";
import { authOriginRequiresHttps } from "./sdks.js";

const hostedAuth = "https://auth.splitch.dev";
const localAuth = "http://127.0.0.1:8789";

describe("device approval URL binding", () => {
  it("accepts a path on the configured hosted Auth origin", () => {
    expect(
      requireVerificationUrl(
        "https://auth.splitch.dev/device?user_code=ABCD-1234",
        "verification_uri_complete",
        hostedAuth,
        true,
      ),
    ).toBe("https://auth.splitch.dev/device?user_code=ABCD-1234");
  });

  it("accepts local HTTP only for an explicit local Auth origin", () => {
    expect(
      requireVerificationUrl(`${localAuth}/device`, "verification_uri", localAuth, false),
    ).toBe("http://127.0.0.1:8789/device");
  });

  it.each([
    ["foreign origin", "https://evil.test/device", hostedAuth, true],
    ["credential-bearing userinfo", "https://user:pass@auth.splitch.dev/device", hostedAuth, true],
    ["port change", "https://auth.splitch.dev:8443/device", hostedAuth, true],
    ["https downgrade", "http://auth.splitch.dev/device", hostedAuth, true],
    ["hosted http even when origin matches", `${localAuth}/device`, localAuth, true],
    ["local foreign https", "https://auth.splitch.dev/device", localAuth, false],
    ["javascript scheme", "javascript:alert(1)", hostedAuth, true],
    ["file scheme", "file:///tmp/approval", hostedAuth, true],
  ])("rejects a %s device URL without echoing it", (_case, value, authBaseUrl, requireHttps) => {
    try {
      requireVerificationUrl(value, "verification_uri", authBaseUrl, requireHttps);
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
