export class CanonicalJsonInputError extends TypeError {}

/** RFC 8785 JSON Canonicalization Scheme for hash-stable control-plane evidence. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarSequence(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonInputError("canonical JSON requires finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => {
        assertUnicodeScalarSequence(key);
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      })
      .join(",")}}`;
  }
  throw new CanonicalJsonInputError(`canonical JSON does not support ${typeof value}`);
}

export async function canonicalHash(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function assertUnicodeScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    }
    throw new CanonicalJsonInputError("canonical JSON rejects lone Unicode surrogates");
  }
}
