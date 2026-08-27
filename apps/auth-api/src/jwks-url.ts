/**
 * SSRF boundary for tenant-supplied JWKS URLs.
 *
 * `jwks_uri` is tenant-owned config. The Worker later fetches it from inside
 * Cloudflare's network to verify ID-JAG signatures. Tenant ownership does not
 * grant network reachability: an unvalidated host would let stored tenant input
 * become SSRF when ID-JAG resumes.
 *
 * Create-time parsing rejects unsafe URL shape and non-global IP literals.
 * Hostnames are re-checked on the live connection before any HTTP is sent:
 * see `fetchTrustedJwks`. A legacy D1 row cannot bypass either gate.
 */

import { isGlobalIPv4, isGlobalIPv6, parseIPv4, parseIPv6 } from "./jwks-ip";

export type JwksUrlParse = { ok: true; href: string } | { ok: false; error: string };

export function jwksUrlError(value: string): string | null {
  const parsed = parseJwksUrl(value);
  return parsed.ok ? null : parsed.error;
}

export function normalizeJwksUrl(value: string): string {
  const parsed = parseJwksUrl(value);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.href;
}

export function parseJwksUrl(value: string): JwksUrlParse {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "jwks_uri is not a valid URL" };
  }
  if (hasExplicitAuthorityPort(trimmed)) {
    return fail("jwks_uri must not specify a port");
  }
  return shapeError(url) ?? hostError(url) ?? { ok: true, href: url.href };
}

function shapeError(url: URL): JwksUrlParse | null {
  if (url.protocol !== "https:") return fail("jwks_uri must use https");
  if (url.username || url.password) return fail("jwks_uri must not carry credentials");
  if (url.port) return fail("jwks_uri must not specify a port");
  if (url.search || url.hash) {
    return fail("jwks_uri must not carry a query string or fragment");
  }
  return null;
}

function hostError(url: URL): JwksUrlParse | null {
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return fail("jwks_uri host is not allowed");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return fail("jwks_uri host is not allowed");
  }
  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) {
    return isGlobalIPv4(ipv4) ? null : fail("jwks_uri host is not allowed");
  }
  const ipv6 = parseIPv6(host);
  if (ipv6 !== null) {
    return isGlobalIPv6(ipv6) ? null : fail("jwks_uri host is not allowed");
  }
  return host.includes(":") ? fail("jwks_uri host is not allowed") : null;
}

function hasExplicitAuthorityPort(raw: string): boolean {
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd === -1) return false;
  let authority = raw.slice(schemeEnd + 3);
  const end = authority.search(/[/?#]/);
  if (end !== -1) authority = authority.slice(0, end);
  const userinfo = authority.lastIndexOf("@");
  if (userinfo !== -1) authority = authority.slice(userinfo + 1);
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return close !== -1 && authority[close + 1] === ":";
  }
  return authority.includes(":");
}

function fail(error: string): JwksUrlParse {
  return { ok: false, error };
}
