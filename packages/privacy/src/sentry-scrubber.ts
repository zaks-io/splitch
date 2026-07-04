/**
 * Sentry-event boundary scrubber: the `beforeSend` body.
 *
 * STRATEGY — allow-list traversal, not denylist enumeration. We recursively scrub
 * EVERY field of the event (message, extra, contexts, breadcrumbs incl. their
 * `message` and `data`, exception values, request, tags, and anything else),
 * MINUS an explicit allow-list of known-safe operational fields kept readable.
 *
 * WHY: enumerating only the handful of paths we know about leaks the moment Sentry
 * (or our own code) adds a new field that carries PII. Scrub-by-default + a small
 * allow-list is fail-safe: a new field is redacted until someone deliberately
 * vouches for it. The operational allow-list is how the error stays reportable
 * (event_id, level, sdk, release, user.id-as-operator, etc.) —
 * see docs/spec/frontend/observability-pii-scrubbing.md "What is NOT scrubbed".
 */

import { REDACTED } from "./redaction-rules";
import { scrubValue, type ScrubOptions } from "./scrubber";

export type SentryEventLike = Record<string, unknown>;

/**
 * Top-level event keys that are operational metadata, never customer end-user
 * PII, and must remain readable. Everything NOT in this set is scrubbed.
 */
const ALLOWED_TOP_LEVEL_KEYS = new Set<string>([
  "event_id",
  "timestamp",
  "level",
  "platform",
  "logger",
  "server_name",
  "environment",
  "release",
  "dist",
  "sdk",
  "transaction",
  "transaction_info",
]);

/**
 * `user` is handled specially: the spec vouches for ONLY `user.id` (the splitch
 * operator id from `Sentry.setUser({ id: ctx.userId })`). Sentry auto-populates
 * `user.ip_address` and apps commonly attach `user.email` / `user.username` —
 * all customer end-user PII. So we keep `user.id` verbatim and scrub every other
 * field under `user` (observability-pii-scrubbing.md "What is NOT scrubbed").
 */
function scrubUser(user: unknown, options: ScrubOptions): unknown {
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return scrubValue(user, options);
  }
  // Whole-subtree redact: ONLY `id` (the operator id) is vouched for. Every other
  // user field is end-user PII (email, username, ip_address), so replace its value
  // outright — recursing would lose the key context for a plain-string value like
  // a username that matches no PII shape.
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(user)) {
    output[key] = key === "id" ? (user as Record<string, unknown>).id : REDACTED;
  }
  return output;
}

/**
 * Scrub a Sentry event. Returns a new event: allow-listed top-level fields pass
 * through verbatim; `user` keeps only `id`; every other field is deeply scrubbed
 * (strings, objects, arrays, embedded JSON, and bare PII value patterns).
 */
export function scrubSentryEvent<T extends SentryEventLike>(
  event: T,
  options: ScrubOptions = {},
): T {
  const output: SentryEventLike = {};
  for (const [key, value] of Object.entries(event)) {
    if (ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      output[key] = value;
    } else if (key === "user") {
      output[key] = scrubUser(value, options);
    } else {
      output[key] = scrubValue(value, options);
    }
  }
  return output as T;
}
