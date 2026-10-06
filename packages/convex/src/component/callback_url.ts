import { configurationCallbackUrlError } from "@splitch/sdk/local-evaluation";

export function configurationCallbackUrl(siteUrl: string): string {
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error("CONVEX_SITE_URL must be a valid public HTTPS URL");
  }
  site.pathname = `${site.pathname.replace(/\/$/, "")}/configuration`;
  const callbackUrl = site.toString();
  const error = configurationCallbackUrlError(callbackUrl);
  if (error) throw new Error(`CONVEX_SITE_URL ${error}`);
  return callbackUrl;
}
