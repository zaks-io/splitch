/**
 * Redaction policy: which keys carry customer end-user PII and must have their
 * VALUE replaced (never the key deleted — deletion can break Sentry/Axiom schema
 * validation, per docs/spec/frontend/observability-pii-scrubbing.md).
 *
 * Two rule families:
 *  1. Container keys — once a key matches, EVERYTHING beneath it is PII by design
 *     (`targeting`, `context`, `evaluationContext`). Spec calls these `targeting.*`
 *     etc.
 *  2. Leaf PII names — the bare Targeting Key and common identifier fields, scrubbed
 *     wherever they appear at any depth (`targetingKey`, `email`, phone, ...).
 *
 * WHY allow-list the safe operational fields elsewhere instead of here: this file
 * only decides what IS PII. The scrubber recursion (scrubber.ts) owns traversal.
 */

export const REDACTED = "[Redacted]";

/**
 * Keys whose entire subtree is customer Evaluation Context / targeting PII. Match
 * is case-insensitive on the key name. Everything nested under a match is redacted.
 */
const CONTAINER_KEYS = ["targeting", "context", "evaluationcontext"] as const;

/**
 * Leaf key names that are PII wherever they appear. `targetingkey` is mandated by
 * spec; the rest are the "common PII names" the verification contract requires
 * (email, phone, end-user identifiers, names, address-like fields).
 */
const LEAF_PII_KEYS = [
  "authorization",
  "cookie",
  "cookies",
  // Credential-bearing keys: like `authorization`/`cookie`, a secret carried
  // under one of these names must never reach Sentry/Axiom verbatim.
  "password",
  "secret",
  "clientsecret",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "targetingkey",
  "email",
  "phone",
  "phonenumber",
  "firstname",
  "lastname",
  "fullname",
  "name",
  "username",
  "address",
  "ipaddress",
  "setcookie",
  "ssn",
] as const;

// Strip `_`/`-` so `ip_address`, `ip-address`, and `ipAddress` all normalize to
// the same canonical key — Sentry/Axiom field names vary in separator style.
function normalize(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** True when this key opens a subtree that is entirely customer PII. */
export function isContainerKey(key: string): boolean {
  return (CONTAINER_KEYS as readonly string[]).includes(normalize(key));
}

/** True when this leaf key name is PII regardless of nesting depth. */
export function isLeafPiiKey(key: string): boolean {
  return (LEAF_PII_KEYS as readonly string[]).includes(normalize(key));
}

/** Any key that must have its value redacted on a direct match. */
export function isPiiKey(key: string): boolean {
  return isContainerKey(key) || isLeafPiiKey(key);
}
