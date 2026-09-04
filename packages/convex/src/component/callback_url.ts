// No imports on purpose: the Control Plane's matching allowlist predicate lives in the private
// tree and cannot depend on this published package, so the private pin test imports this file
// directly. Keep it free of Convex runtime and workspace imports (SPL-601).

const CLOUD_SUFFIX = ".convex.cloud";
const SITE_SUFFIX = ".convex.site";

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

// `".convex.site".endsWith(".convex.site")` is true, so a bare suffix check admits hosts whose
// deployment label is empty. Those never resolve, but they read as canonical.
function hasDeploymentLabel(hostname: string, suffix: string): boolean {
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return label.length > 0 && !label.endsWith(".");
}

// `origin` is the only part of the URL safe to quote back: it drops userinfo, so a pasted
// credential cannot reach the message. Name the violated constraint alongside it, because a value
// that breaks only the path or the credentials renders an origin that looks entirely correct.
function cloudUrlViolation(cloud: URL): string | null {
  if (cloud.protocol !== "https:") return `uses the ${cloud.protocol} scheme`;
  if (!hasDeploymentLabel(cloud.hostname, CLOUD_SUFFIX)) return `points at ${cloud.origin}`;
  if (cloud.username || cloud.password) return "carries embedded credentials";
  if (cloud.port) return `pins port ${cloud.port}`;
  if (cloud.pathname !== "/") return "carries a path";
  if (cloud.search) return "carries a query string";
  if (cloud.hash) return "carries a fragment";
  return null;
}

export function canonicalCallbackUrl(cloudUrl: string, siteUrl: string): string {
  const cloud = new URL(cloudUrl);
  const violation = cloudUrlViolation(cloud);
  if (violation)
    throw new Error(
      `CONVEX_CLOUD_URL ${violation}, so it is not the default ` +
        "https://<deployment>.convex.cloud. @splitch/convex reads the deployment name from it to " +
        "build the *.convex.site callback Splitch accepts, and a component has no other source " +
        "for that name. Convex custom domains for the Convex API work by overriding " +
        "CONVEX_CLOUD_URL, so clear that override under Deployment Settings > Override " +
        "Environment Variables and rerun install. A custom domain on HTTP Actions overrides " +
        "CONVEX_SITE_URL instead and is supported.",
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
  cloud.hostname = `${cloud.hostname.slice(0, -CLOUD_SUFFIX.length)}${SITE_SUFFIX}`;
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
      hasDeploymentLabel(url.hostname, SITE_SUFFIX) &&
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
