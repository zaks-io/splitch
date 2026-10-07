import { describe, expect, it } from "vitest";
import { configurationCallbackUrl } from "./callback_url";

describe("configurationCallbackUrl", () => {
  it.each([
    ["https://third-cat-295.convex.site", "https://third-cat-295.convex.site/configuration"],
    ["https://hooks.mainstay.club", "https://hooks.mainstay.club/configuration"],
    [
      "https://hooks.mainstay.club/integrations/splitch",
      "https://hooks.mainstay.club/integrations/splitch/configuration",
    ],
    [
      "https://hooks.mainstay.club/integrations/splitch/",
      "https://hooks.mainstay.club/integrations/splitch/configuration",
    ],
  ])("preserves the HTTP Actions origin and mount path of %s", (siteUrl, expected) => {
    expect(configurationCallbackUrl(siteUrl)).toBe(expected);
  });

  it.each([
    "not a URL",
    "http://hooks.mainstay.club/integrations/splitch",
    "https://user:pass@hooks.mainstay.club/integrations/splitch",
    "https://hooks.mainstay.club:8443/integrations/splitch",
    "https://hooks.mainstay.club/integrations/splitch?target=other",
    "https://hooks.mainstay.club/integrations/splitch#other",
    "https://localhost/integrations/splitch",
    "https://127.0.0.1/integrations/splitch",
    "https://[::1]/integrations/splitch",
    "https://third-cat-295..convex.site/integrations/splitch",
  ])("rejects an unsafe HTTP Actions URL %s", (siteUrl) => {
    expect(() => configurationCallbackUrl(siteUrl)).toThrow("CONVEX_SITE_URL");
  });

  it("keeps credentials out of parse and validation errors", () => {
    for (const siteUrl of ["https://user:pass@", "https://user:pass@hooks.mainstay.club"]) {
      expect(() => configurationCallbackUrl(siteUrl)).toThrow(expect.not.stringContaining("pass@"));
    }
  });
});
