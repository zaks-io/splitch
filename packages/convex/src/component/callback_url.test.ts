import { describe, expect, it } from "vitest";
import { canonicalCallbackUrl, isCanonicalCallbackUrl } from "./callback_url";

describe("canonicalCallbackUrl", () => {
  it("preserves the component mount path on the canonical Convex site origin", () => {
    expect(
      canonicalCallbackUrl(
        "https://third-cat-295.convex.cloud",
        "https://api.mainstay.club/integrations/splitch",
      ),
    ).toBe("https://third-cat-295.convex.site/integrations/splitch/configuration");
  });

  it.each([
    "https://api.mainstay.club",
    "http://third-cat-295.convex.cloud",
    "https://third-cat-295.convex.cloud:8443",
    "https://third-cat-295.convex.cloud/?target=other",
  ])("refuses an overridden CONVEX_CLOUD_URL: %s", (cloudUrl) => {
    expect(() =>
      canonicalCallbackUrl(cloudUrl, "https://api.mainstay.club/integrations/splitch"),
    ).toThrow("not the default https://<deployment>.convex.cloud");
  });

  it("names the override and the operator action in the refusal", () => {
    expect(() =>
      canonicalCallbackUrl(
        "https://api.mainstay.club",
        "https://api.mainstay.club/integrations/splitch",
      ),
    ).toThrow(
      /CONVEX_CLOUD_URL is https:\/\/api\.mainstay\.club, .*Override Environment Variables/s,
    );
  });

  it("rejects malformed automatic site URLs", () => {
    expect(() =>
      canonicalCallbackUrl(
        "https://third-cat-295.convex.cloud",
        "http://api.mainstay.club/integrations/splitch",
      ),
    ).toThrow("CONVEX_SITE_URL must be an HTTPS URL containing the component mount path");
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
