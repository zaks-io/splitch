/**
 * Build-time resolution of the public Cloudflare Web Analytics site token.
 * Production builds fail here rather than shipping a page that silently
 * reports nothing, and non-production builds never inline the token at all.
 */
export function resolveViteCloudflareWebAnalyticsToken(platformTarget: string): string {
  if (platformTarget !== "production") {
    return "";
  }

  const siteToken = (process.env.CLOUDFLARE_WEB_ANALYTICS_TOKEN ?? "").trim();

  if (!siteToken) {
    throw new Error(
      "CLOUDFLARE_WEB_ANALYTICS_TOKEN is required for a production build; set it from the Cloudflare Web Analytics site token",
    );
  }

  // A GitHub repository variable keeps whatever was pasted into it. A token
  // carrying a stray quote or delimiter would build green and report nothing.
  if (!/^[A-Za-z0-9_-]+$/.test(siteToken)) {
    throw new Error(
      "CLOUDFLARE_WEB_ANALYTICS_TOKEN is not a Cloudflare Web Analytics site token; expected an unpunctuated alphanumeric value",
    );
  }

  return siteToken;
}
