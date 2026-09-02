import { describe, expect, it } from "vitest";
import {
  canonicalCallbackUrl,
  installRejected,
  isCanonicalCallbackUrl,
} from "./integration_remote";

describe("canonicalCallbackUrl", () => {
  it("preserves the component mount path on the canonical Convex site origin", () => {
    expect(canonicalCallbackUrl("https://third-cat-295.convex.cloud/integrations/splitch")).toBe(
      "https://third-cat-295.convex.site/integrations/splitch/configuration",
    );
  });

  it.each([
    "https://api.mainstay.club/integrations/splitch",
    "http://third-cat-295.convex.cloud/integrations/splitch",
    "https://third-cat-295.convex.cloud:8443/integrations/splitch",
    "https://third-cat-295.convex.cloud/integrations/splitch?target=other",
  ])("rejects a non-canonical automatic cloud URL: %s", (cloudUrl) => {
    expect(() => canonicalCallbackUrl(cloudUrl)).toThrow(
      "CONVEX_CLOUD_URL must be a canonical HTTPS *.convex.cloud URL",
    );
  });
});

describe("isCanonicalCallbackUrl", () => {
  it("accepts only the canonical Convex configuration endpoint", () => {
    expect(
      isCanonicalCallbackUrl(
        "https://third-cat-295.convex.site/integrations/splitch/configuration",
      ),
    ).toBe(true);
    expect(
      isCanonicalCallbackUrl("https://api.mainstay.club/integrations/splitch/configuration"),
    ).toBe(false);
    expect(isCanonicalCallbackUrl("not a URL")).toBe(false);
  });
});

describe("installRejected", () => {
  it("reports the response verbatim for a refusal that is not a scope refusal", () => {
    const body = JSON.stringify({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict" });

    const error = installRejected(409, body);

    expect(error.message).toBe(`install Convex integration failed with HTTP 409: ${body}`);
  });

  it("reports a non-JSON body verbatim instead of guessing at a cause", () => {
    const error = installRejected(502, "<html>bad gateway</html>");

    expect(error.message).toBe(
      "install Convex integration failed with HTTP 502: <html>bad gateway</html>",
    );
  });
});
