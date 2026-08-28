/**
 * Cloudflare Web Analytics RUM beacon, installed manually because automatic
 * injection never fires on HTML that a Worker generates.
 * https://developers.cloudflare.com/web-analytics/get-started/#sites-not-proxied-through-cloudflare
 *
 * The site token is public: it ships in the HTML of every measured page. One
 * token covers every hostname under the splitch.dev apex.
 */
export type CloudflareWebAnalyticsScript = {
  src: string;
  defer: true;
  "data-cf-beacon": string;
};

export type CloudflareWebAnalyticsOptions = {
  platformTarget: string | undefined;
  siteToken: string | undefined;
};

/**
 * Body scripts for the beacon, empty outside production so preview traffic
 * stays out of the numbers.
 *
 * The token rides in `data-cf-beacon` rather than a `?token=` query string, and
 * the tag stays a classic script rather than a module. beacon.min.js reads its
 * config from `document.currentScript || document.querySelector("script[data-cf-beacon]")`
 * and returns early when neither resolves: `document.currentScript` is null
 * inside a module script, so a module tag carrying only `?token=` loads,
 * finds no config, and silently reports nothing.
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
      src: "https://static.cloudflareinsights.com/beacon.min.js",
      defer: true,
      "data-cf-beacon": JSON.stringify({ token: siteToken }),
    },
  ];
}
