import { createHash } from "node:crypto";

/**
 * The frozen-configuration hash a Run carries, computed the same way for every
 * fixture module. It lives on its own so a second fixture file can seed a Run
 * without re-deriving the hashing rule — two derivations would drift, and a Run
 * whose stored hash disagrees with its stored configuration fails loudly at read
 * time rather than where the fixture was written.
 */
export function runConfigHash({ salt, allocation, variantSet, targetingRules }) {
  const config = { salt, allocation, variantSet, targetingRules };
  return `sha256:${createHash("sha256").update(stableStringify(config)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
