/**
 * Global-unicast checks for JWKS destinations.
 *
 * Tenant ownership of a hostname does not grant Worker reachability. A literal
 * or a connected peer is allowed only when every IPv4/IPv6 address is globally
 * routable. Special-use, multicast, documentation, and IPv4 embeddings fail closed.
 */

export function parseIPv4(host: string): number | null {
  return parsePackedIPv4(host) ?? parseDottedIPv4(host);
}

export function parseIPv6(host: string): number[] | null {
  const addr = ipv6Address(host);
  if (addr === null) return null;
  const { head, ipv4Tail } = splitIpv4Tail(addr);
  if (head === null) return null;
  return expandIpv6(head, ipv4Tail);
}

export function isGlobalIPv4(address: number): boolean {
  return !isNonGlobalIPv4(address);
}

export function isGlobalIPv6(groups: number[]): boolean {
  if (groups.length !== 8) return false;
  if (!isIpv6GlobalUnicast(groups)) return false;
  if (isIpv6SpecialUse(groups)) return false;
  const embedded = embeddedIPv4(groups);
  return embedded === null || isGlobalIPv4(embedded);
}

/** Peer string from `SocketInfo.remoteAddress` — missing or unclassifiable is denied. */
export function isGlobalRemoteAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  const host = peerHost(value);
  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) return isGlobalIPv4(ipv4);
  const ipv6 = parseIPv6(host);
  return ipv6 !== null && isGlobalIPv6(ipv6);
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

const NON_GLOBAL_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00_00_00_00, 0x00_ff_ff_ff],
  [0x0a_00_00_00, 0x0a_ff_ff_ff],
  [0x64_40_00_00, 0x64_7f_ff_ff],
  [0x7f_00_00_00, 0x7f_ff_ff_ff],
  [0xa9_fe_00_00, 0xa9_fe_ff_ff],
  [0xac_10_00_00, 0xac_1f_ff_ff],
  [0xc0_00_00_00, 0xc0_00_00_ff],
  [0xc0_00_02_00, 0xc0_00_02_ff],
  [0xc0_58_63_00, 0xc0_58_63_ff],
  [0xc0_a8_00_00, 0xc0_a8_ff_ff],
  [0xc6_12_00_00, 0xc6_13_ff_ff],
  [0xc6_33_64_00, 0xc6_33_64_ff],
  [0xcb_00_71_00, 0xcb_00_71_ff],
  [0xe0_00_00_00, 0xff_ff_ff_ff],
];

function isNonGlobalIPv4(address: number): boolean {
  return NON_GLOBAL_IPV4_RANGES.some(([start, end]) => inRange(address, start, end));
}

function inRange(address: number, start: number, end: number): boolean {
  return address >= start && address <= end;
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

function isIpv6GlobalUnicast(groups: number[]): boolean {
  const first = groups[0] ?? 0;
  return first >= 0x2000 && first <= 0x3fff;
}

function isIpv6SpecialUse(groups: number[]): boolean {
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  if (first === 0x2001 && second <= 0x01ff) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x2002) return true;
  return first === 0x3fff && second <= 0x0fff;
}

function embeddedIPv4(groups: number[]): number | null {
  if (hasIpv4TailEmbedding(groups)) {
    return ipv4FromHextets(groups[6] ?? 0, groups[7] ?? 0);
  }
  if ((groups[0] ?? 0) !== 0x2002) return null;
  return ipv4FromHextets(groups[1] ?? 0, groups[2] ?? 0);
}

function hasIpv4TailEmbedding(groups: number[]): boolean {
  return (
    isLast32BitIpv4Embedding(groups) ||
    isIpv4Mapped(groups) ||
    isIpv4Translated(groups) ||
    isNat64(groups)
  );
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

function peerHost(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(1, close);
  }
  if (parseIPv4(trimmed) !== null || parseIPv6(trimmed) !== null) return trimmed;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return trimmed;
  const head = trimmed.slice(0, lastColon);
  return parseIPv4(head) !== null ? head : trimmed;
}
