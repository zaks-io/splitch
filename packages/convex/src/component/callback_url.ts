// No imports on purpose: the Control Plane's matching allowlist predicate lives in the private
// tree and cannot depend on this published package, so the private pin test imports this file
// directly. Keep it free of Convex runtime and workspace imports (SPL-601).

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function canonicalCallbackUrl(cloudUrl: string, siteUrl: string): string {
  const cloud = new URL(cloudUrl);
  if (
    cloud.protocol !== "https:" ||
    !cloud.hostname.endsWith(".convex.cloud") ||
    cloud.username ||
    cloud.password ||
    cloud.port ||
    cloud.pathname !== "/" ||
    cloud.search ||
    cloud.hash
  )
    throw new Error(
      `CONVEX_CLOUD_URL is ${cloud.origin}, not the default https://<deployment>.convex.cloud. ` +
        "@splitch/convex reads the deployment name from it to build the *.convex.site callback " +
        "Splitch accepts, and a component has no other source for that name. Convex custom " +
        "domains for the Convex API work by overriding CONVEX_CLOUD_URL, so clear that override " +
        "under Deployment Settings > Override Environment Variables and rerun install. A custom " +
        "domain on HTTP Actions overrides CONVEX_SITE_URL instead and is supported.",
    );
  const site = new URL(siteUrl);
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.port ||
    site.search ||
    site.hash
  )
    throw new Error("CONVEX_SITE_URL must be an HTTPS URL containing the component mount path");
  cloud.hostname = `${cloud.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return new URL(
    "configuration",
    `${cloud.origin}${ensureTrailingSlash(site.pathname)}`,
  ).toString();
}

export function isCanonicalCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".convex.site") &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith("/configuration")
    );
  } catch {
    return false;
  }
}
