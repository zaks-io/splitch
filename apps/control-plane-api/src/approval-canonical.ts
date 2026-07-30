import type { ApprovalDiff, ApprovalDiffEntry } from "@splitch/contracts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidTime = -1;
let lastUlidRandom = new Uint8Array(10);

export function approvalRequestId(now = Date.now()): string {
  return `apr_${ulid(now)}`;
}

export function approvalReviewId(now = Date.now()): string {
  return `rev_${ulid(now)}`;
}

export async function canonicalHash(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // RFC 8785 has no `undefined`, and neither does JSON: an explicitly
    // undefined property is omitted exactly as `JSON.stringify` omits it,
    // rather than throwing mid-request on a patch object built in JS.
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function approvalDiff(
  current: Record<string, unknown>,
  proposed: Record<string, unknown>,
): ApprovalDiff {
  const entries: ApprovalDiffEntry[] = [];
  diffValue(current, proposed, "", entries);
  // Code-unit order, not `localeCompare`: the diff is hashed, and ICU collation
  // orders punctuation and case differently across runtimes, which would give
  // the same proposal two canonical forms and two request hashes.
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { current, proposed, entries };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the recursive JSON diff keeps every add/remove/replace branch explicit
function diffValue(
  current: unknown,
  proposed: unknown,
  path: string,
  entries: ApprovalDiffEntry[],
): void {
  if (canonicalJson(current) === canonicalJson(proposed)) return;
  if (isRecord(current) && isRecord(proposed)) {
    const keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])].sort();
    for (const key of keys) {
      const childPath = `${path}/${escapePointer(key)}`;
      const inCurrent = present(current, key);
      const inProposed = present(proposed, key);
      if (!(inCurrent || inProposed)) continue;
      if (!inCurrent) {
        entries.push({ path: childPath, operation: "add", proposed: proposed[key] });
      } else if (!inProposed) {
        entries.push({ path: childPath, operation: "remove", current: current[key] });
      } else {
        diffValue(current[key], proposed[key], childPath, entries);
      }
    }
    return;
  }
  entries.push({ path: path || "/", operation: "replace", current, proposed });
}

/** A key holding `undefined` is absent, the way `JSON.stringify` sees it. */
function present(record: Record<string, unknown>, key: string): boolean {
  return key in record && record[key] !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function ulid(now: number): string {
  const timestamp = Math.max(0, Math.floor(now));
  if (timestamp === lastUlidTime) {
    incrementRandom(lastUlidRandom);
  } else {
    lastUlidTime = timestamp;
    lastUlidRandom = crypto.getRandomValues(new Uint8Array(10));
  }
  return `${encodeTime(timestamp)}${encodeRandom(lastUlidRandom)}`;
}

function encodeTime(value: number): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += CROCKFORD[(bits >>> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
  }
  return encoded.padEnd(16, "0");
}

function incrementRandom(bytes: Uint8Array): void {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const next = (bytes[index] ?? 0) + 1;
    bytes[index] = next & 0xff;
    if (next <= 0xff) return;
  }
  throw new Error("ULID random space exhausted for one millisecond");
}
