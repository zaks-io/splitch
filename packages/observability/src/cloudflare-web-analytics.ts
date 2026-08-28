/**
 * Cloudflare Web Analytics RUM beacon, installed manually because automatic
 * injection never fires on HTML that a Worker generates.
 * https://developers.cloudflare.com/web-analytics/get-started/#sites-not-proxied-through-cloudflare
 *
 * The site token is public: it ships in the HTML of every measured page. One
 * token covers every hostname under the splitch.dev apex.
 */
export type CloudflareWebAnalyticsScript = {
  type: "module";
  src: string;
};

export type CloudflareWebAnalyticsOptions = {
  platformTarget: string | undefined;
  siteToken: string | undefined;
};

/**
 * Head scripts for the beacon, empty outside production so preview traffic
 * stays out of the numbers.
 */
export function cloudflareWebAnalyticsScripts({
  platformTarget,
  siteToken,
}: CloudflareWebAnalyticsOptions): Array<CloudflareWebAnalyticsScript> {
  if (platformTarget !== "production") {
    return [];
  }

  if (!siteToken) {
    throw new Error(
      "Cloudflare Web Analytics site token is missing from a production build; set CLOUDFLARE_WEB_ANALYTICS_TOKEN",
    );
  }

  return [
    {
      type: "module",
      src: `https://static.cloudflareinsights.com/beacon.min.js?token=${siteToken}`,
    },
  ];
}
