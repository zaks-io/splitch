/**
 * SSRF boundary for tenant-supplied JWKS URLs.
 *
 * `jwks_uri` is tenant-owned config. The Worker later fetches it from inside
 * Cloudflare's network to verify ID-JAG signatures. Tenant ownership does not
 * grant network reachability: an unvalidated host would let stored tenant input
 * become SSRF when ID-JAG resumes.
 *
 * Enforced at create time AND again immediately before fetch. Create-time
 * alone is not enough: the row outlives the request, and a future migration,
 * restore, or direct D1 write must not be able to smuggle a host past the check.
 *
 * The fetch wrapper never follows redirects. jose already requests
 * `redirect: "manual"`; this wrapper keeps that contract even if a caller
 * supplies a different init, so a 302 Location cannot aim the Worker at a
 * host that never passed the policy.
 */

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
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "jwks_uri is not a valid URL" };
  }
  return shapeError(url) ?? hostError(url) ?? { ok: true, href: url.href };
}

/**
 * Outbound GET used for tenant JWKS. Re-checks the URL, then fetches without
 * following redirects so a disallowed Location cannot become the real target.
 */
export async function fetchTrustedJwks(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const parsed = parseJwksUrl(url);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return fetcher(parsed.href, { ...init, redirect: "manual" });
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
    return isBlockedIPv4(ipv4) ? fail("jwks_uri host is not allowed") : null;
  }
  const ipv6 = parseIPv6(host);
  if (ipv6 !== null) {
    return isBlockedIPv6(ipv6) ? fail("jwks_uri host is not allowed") : null;
  }
  // A colon in hostname is an IPv6 literal. If we cannot classify it, fail closed.
  return host.includes(":") ? fail("jwks_uri host is not allowed") : null;
}

function fail(error: string): JwksUrlParse {
  return { ok: false, error };
}

function parseIPv4(host: string): number | null {
  return parsePackedIPv4(host) ?? parseDottedIPv4(host);
}

function parsePackedIPv4(host: string): number | null {
  if (!/^\d+$/.test(host) && !/^0x[0-9a-f]+$/i.test(host)) return null;
  const n = Number(host);
  if (!Number.isInteger(n) || n < 0 || n > 0xff_ff_ff_ff) return null;
  return n >>> 0;
}

function parseDottedIPv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const a = parseOctet(parts[0] ?? "");
  const b = parseOctet(parts[1] ?? "");
  const c = parseOctet(parts[2] ?? "");
  const d = parseOctet(parts[3] ?? "");
  if (a === null || b === null || c === null || d === null) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseOctet(part: string): number | null {
  if (!/^\d+$/.test(part)) return null;
  const n = Number(part);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

function isBlockedIPv4(address: number): boolean {
  if (address <= 0x00_ff_ff_ff) return true;
  if (address >= 0x0a_00_00_00 && address <= 0x0a_ff_ff_ff) return true;
  if (address >= 0x7f_00_00_00 && address <= 0x7f_ff_ff_ff) return true;
  if (address >= 0xa9_fe_00_00 && address <= 0xa9_fe_ff_ff) return true;
  if (address >= 0xac_10_00_00 && address <= 0xac_1f_ff_ff) return true;
  return address >= 0xc0_a8_00_00 && address <= 0xc0_a8_ff_ff;
}

function parseIPv6(host: string): number[] | null {
  const addr = ipv6Address(host);
  if (addr === null) return null;
  const { head, ipv4Tail } = splitIpv4Tail(addr);
  if (head === null) return null;
  return expandIpv6(head, ipv4Tail);
}

function ipv6Address(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare.includes(":")) return null;
  return (bare.split("%")[0] ?? bare).toLowerCase();
}

function splitIpv4Tail(addr: string): { head: string | null; ipv4Tail: number | null } {
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (!tail.includes(".")) return { head: addr, ipv4Tail: null };
  const ipv4Tail = parseIPv4(tail);
  return ipv4Tail === null
    ? { head: null, ipv4Tail: null }
    : { head: addr.slice(0, lastColon), ipv4Tail };
}

function expandIpv6(head: string, ipv4Tail: number | null): number[] | null {
  const sides = ipv6Sides(head);
  if (sides === null) return null;
  const needed = ipv4Tail === null ? 8 : 6;
  if (!sides.compressed) {
    return sides.left.length === needed ? finishIPv6(sides.left, ipv4Tail) : null;
  }
  const missing = needed - sides.left.length - sides.right.length;
  if (missing < 0) return null;
  return finishIPv6([...sides.left, ...Array<number>(missing).fill(0), ...sides.right], ipv4Tail);
}

function ipv6Sides(head: string): { left: number[]; right: number[]; compressed: boolean } | null {
  const compression = head.indexOf("::");
  if (compression !== -1 && head.indexOf("::", compression + 1) !== -1) return null;
  const [leftRaw, rightRaw] = compression === -1 ? [head, undefined] : head.split("::");
  const left = parseHexGroups(leftRaw ?? "");
  const right = rightRaw === undefined ? [] : parseHexGroups(rightRaw);
  if (left === null || right === null) return null;
  return { left, right, compressed: compression !== -1 };
}

function parseHexGroups(part: string): number[] | null {
  if (part === "") return [];
  const groups: number[] = [];
  for (const group of part.split(":")) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

function finishIPv6(groups: number[], ipv4Tail: number | null): number[] {
  if (ipv4Tail === null) return groups;
  return [...groups, (ipv4Tail >>> 16) & 0xffff, ipv4Tail & 0xffff];
}

function isBlockedIPv6(groups: number[]): boolean {
  if (groups.length !== 8) return true;
  if (isUnspecifiedOrLoopback6(groups)) return true;
  const first = groups[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00) return true;
  return embedsBlockedIPv4(groups);
}

function isUnspecifiedOrLoopback6(groups: number[]): boolean {
  if (groups.every((group) => group === 0)) return true;
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

function embedsBlockedIPv4(groups: number[]): boolean {
  const embedded = embeddedIPv4(groups);
  return embedded !== null && isBlockedIPv4(embedded);
}

function embeddedIPv4(groups: number[]): number | null {
  if (isLast32BitIpv4Embedding(groups) || isIpv4Mapped(groups) || isIpv4Translated(groups)) {
    return ipv4FromLast32(groups);
  }
  if (isNat64(groups)) return ipv4FromLast32(groups);
  if ((groups[0] ?? 0) !== 0x2002) return null;
  return ipv4FromHextets(groups[1] ?? 0, groups[2] ?? 0);
}

function ipv4FromLast32(groups: number[]): number {
  return ipv4FromHextets(groups[6] ?? 0, groups[7] ?? 0);
}

function ipv4FromHextets(high: number, low: number): number {
  return ((high << 16) | low) >>> 0;
}

function isLast32BitIpv4Embedding(groups: number[]): boolean {
  return groups.slice(0, 6).every((group) => group === 0);
}

function isNat64(groups: number[]): boolean {
  return (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  );
}

function isIpv4Mapped(groups: number[]): boolean {
  return (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  );
}

function isIpv4Translated(groups: number[]): boolean {
  return (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0xffff &&
    groups[5] === 0
  );
}
