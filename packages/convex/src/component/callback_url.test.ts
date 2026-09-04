import { describe, expect, it } from "vitest";
import { canonicalCallbackUrl, isCanonicalCallbackUrl } from "./callback_url";

const CLOUD = "https://third-cat-295.convex.cloud";
const SITE = "https://hooks.mainstay.club/integrations/splitch";
const SITE_REFUSAL = "CONVEX_SITE_URL must be an HTTPS URL containing the component mount path";

describe("canonicalCallbackUrl", () => {
  it("preserves the component mount path on the canonical Convex site origin", () => {
    expect(canonicalCallbackUrl(CLOUD, SITE)).toBe(
      "https://third-cat-295.convex.site/integrations/splitch/configuration",
    );
  });

  it("mounts at the root when CONVEX_SITE_URL carries no path", () => {
    expect(canonicalCallbackUrl(CLOUD, "https://hooks.mainstay.club")).toBe(
      "https://third-cat-295.convex.site/configuration",
    );
  });

  // One row per guard in `cloudUrlViolation`: deleting any single check has to fail here.
  it.each([
    ["plaintext scheme", "http://third-cat-295.convex.cloud", "uses the http: scheme"],
    ["opaque origin", "data:text/plain,convex", "uses the data: scheme"],
    ["custom API domain", "https://api.mainstay.club", "points at https://api.mainstay.club"],
    ["empty deployment label", "https://.convex.cloud", "points at https://.convex.cloud"],
    [
      "empty inner label",
      "https://third-cat-295..convex.cloud",
      "points at https://third-cat-295..convex.cloud",
    ],
    ["username only", "https://user@third-cat-295.convex.cloud", "carries embedded credentials"],
    ["password only", "https://:pass@third-cat-295.convex.cloud", "carries embedded credentials"],
    [
      "username and password",
      "https://user:pass@third-cat-295.convex.cloud",
      "carries embedded credentials",
    ],
    ["nonstandard port", "https://third-cat-295.convex.cloud:8443", "pins port 8443"],
    ["path", "https://third-cat-295.convex.cloud/integrations/splitch", "carries a path"],
    ["query string", "https://third-cat-295.convex.cloud/?target=other", "carries a query string"],
    ["fragment", "https://third-cat-295.convex.cloud/#other", "carries a fragment"],
  ])("refuses an overridden CONVEX_CLOUD_URL that %s", (_label, cloudUrl, violation) => {
    expect(() => canonicalCallbackUrl(cloudUrl, SITE)).toThrow(
      `CONVEX_CLOUD_URL ${violation}, so it is not the default https://<deployment>.convex.cloud`,
    );
  });

  it("points the operator at the setting that clears the override", () => {
    expect(() => canonicalCallbackUrl("https://api.mainstay.club", SITE)).toThrow(
      /Override Environment Variables and rerun install/,
    );
  });

  it("keeps a pasted credential out of the refusal", () => {
    expect(() => canonicalCallbackUrl("https://user:hunter2@api.mainstay.club", SITE)).toThrow(
      expect.not.stringContaining("hunter2"),
    );
  });

  // One row per guard on the site URL.
  it.each([
    ["plaintext scheme", "http://hooks.mainstay.club/integrations/splitch"],
    ["username only", "https://user@hooks.mainstay.club/integrations/splitch"],
    ["password only", "https://:pass@hooks.mainstay.club/integrations/splitch"],
    ["nonstandard port", "https://hooks.mainstay.club:8443/integrations/splitch"],
    ["query string", "https://hooks.mainstay.club/integrations/splitch?target=other"],
    ["fragment", "https://hooks.mainstay.club/integrations/splitch#other"],
  ])("refuses a CONVEX_SITE_URL that carries a %s", (_label, siteUrl) => {
    expect(() => canonicalCallbackUrl(CLOUD, siteUrl)).toThrow(SITE_REFUSAL);
  });
});

describe("isCanonicalCallbackUrl", () => {
  it("accepts the canonical Convex configuration endpoint", () => {
    expect(
      isCanonicalCallbackUrl(
        "https://third-cat-295.convex.site/integrations/splitch/configuration",
      ),
    ).toBe(true);
  });

  it.each([
    ["a custom domain", "https://hooks.mainstay.club/integrations/splitch/configuration"],
    ["an empty deployment label", "https://.convex.site/configuration"],
    ["a malformed value", "not a URL"],
  ])("refuses %s", (_label, value) => {
    expect(isCanonicalCallbackUrl(value)).toBe(false);
  });
});
