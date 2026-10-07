const PRIVATE_SUFFIXES = new Set([
  "localhost",
  "local",
  "localdomain",
  "internal",
  "home",
  "lan",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
  "alt",
]);

// DNS resolution and destination enforcement belong to the outbound transport.
// This shared check keeps registration and component URL construction in agreement.
export function configurationCallbackUrlError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "callbackUrl must be a valid HTTPS URL";
  }
  if (url.protocol !== "https:") return "callbackUrl must use HTTPS";
  if (url.username || url.password) return "callbackUrl must not carry credentials";
  if (url.port) return "callbackUrl must not specify a nonstandard port";
  if (url.search || url.hash) return "callbackUrl must not carry a query string or fragment";
  if (!url.pathname.endsWith("/configuration")) return "callbackUrl must end with /configuration";
  if (!isPublicDnsHostname(url.hostname)) return "callbackUrl must name a public DNS host";
  return null;
}

function isPublicDnsHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^[\d.]+$/.test(hostname) ||
    PRIVATE_SUFFIXES.has(labels.at(-1) ?? "")
  )
    return false;
  return true;
}
