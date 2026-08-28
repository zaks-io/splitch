/**
 * Build-time resolution of the public Cloudflare Web Analytics site token.
 * Production builds fail here rather than shipping a page that silently
 * reports nothing, and non-production builds never inline the token at all.
 */
export function resolveViteCloudflareWebAnalyticsToken(platformTarget: string): string {
  if (platformTarget !== "production") {
    return "";
  }

  const siteToken = process.env.CLOUDFLARE_WEB_ANALYTICS_TOKEN ?? "";

  if (!siteToken) {
    throw new Error(
      "CLOUDFLARE_WEB_ANALYTICS_TOKEN is required for a production build; set it from the Cloudflare Web Analytics site token",
    );
  }

  return siteToken;
}
