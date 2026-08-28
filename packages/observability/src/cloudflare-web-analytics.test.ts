import { describe, expect, it } from "vitest";

import { cloudflareWebAnalyticsScripts } from "./cloudflare-web-analytics.js";

describe("cloudflareWebAnalyticsScripts", () => {
  it("emits a classic beacon tag carrying the token in data-cf-beacon", () => {
    expect(
      cloudflareWebAnalyticsScripts({
        platformTarget: "production",
        siteToken: "site-token-1",
      }),
    ).toEqual([
      {
        src: "https://static.cloudflareinsights.com/beacon.min.js",
        defer: true,
        "data-cf-beacon": '{"token":"site-token-1"}',
      },
    ]);
  });

  it("keeps preview traffic out of the numbers", () => {
    expect(
      cloudflareWebAnalyticsScripts({
        platformTarget: "shared-preview",
        siteToken: "site-token-1",
      }),
    ).toEqual([]);
    expect(
      cloudflareWebAnalyticsScripts({ platformTarget: undefined, siteToken: undefined }),
    ).toEqual([]);
  });

  it("fails loudly when a production build has no site token", () => {
    expect(() =>
      cloudflareWebAnalyticsScripts({ platformTarget: "production", siteToken: "" }),
    ).toThrow(/CLOUDFLARE_WEB_ANALYTICS_TOKEN/);
  });
});
