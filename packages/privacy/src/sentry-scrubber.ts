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

import { isPiiKey, REDACTED } from "./redaction-rules";
import { type ScrubOptions, scrubValue } from "./scrubber";

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
    output[key] = scrubEventField(key, value, options);
  }
  return output as T;
}

function scrubEventField(key: string, value: unknown, options: ScrubOptions): unknown {
  if (ALLOWED_TOP_LEVEL_KEYS.has(key)) return value;
  if (key === "user") return scrubUser(value, options);
  return scrubValue(value, options);
}

/**
 * Span-payload keys that are structural (identity, parentage, timing) or a closed
 * SDK vocabulary. Everything NOT in this set is scrubbed, mirroring the event
 * strategy above.
 *
 * `description` is deliberately ABSENT. A span name is closed-vocabulary only for
 * the spans we build by hand; an auto-instrumented fetch span is named after its
 * URL, and a Control Plane URL can carry a Targeting Key in a path or query
 * segment. Scrubbing it costs nothing for our own names (they match no PII
 * pattern and pass through byte-identical) and is the only thing standing between
 * an outbound request URL and Sentry.
 */
const ALLOWED_SPAN_KEYS = new Set<string>([
  "span_id",
  "parent_span_id",
  "trace_id",
  "segment_id",
  "is_segment",
  "start_timestamp",
  "timestamp",
  "exclusive_time",
  "op",
  "origin",
  "status",
  "profile_id",
]);

/**
 * Span attributes vouched for by name. Every one is either a closed set derived
 * from the API contract (tool/prompt/resource names, MCP method names) or a
 * boolean/count, so none can carry customer data.
 *
 * `mcp.request.argument.*` and `mcp.tool.result.content` are absent BY DESIGN, not
 * by omission: Sentry gates them behind `recordInputs`/`recordOutputs`, and our
 * tool arguments carry Targeting Keys, flag keys, and free-form Evaluation
 * Context. Recording them would put customer data into span attributes, which is
 * exactly what ADR-0032 forbids. They stay unrecorded at the call site, and the
 * fallthrough here redacts them if anyone ever adds them back.
 */
const ALLOWED_SPAN_ATTRIBUTE_KEYS = new Set<string>([
  "mcp.method.name",
  "mcp.tool.name",
  "mcp.resource.uri",
  "mcp.prompt.name",
  "mcp.transport",
  "network.transport",
  "mcp.tool.result.is_error",
  "mcp.tool.result.content_count",
]);

/**
 * The two attribute namespaces Sentry's own MCP instrumentation puts behind
 * `sendDefaultPii` / `recordInputs` / `recordOutputs`: raw tool arguments and raw
 * tool result content. Redacted by namespace rather than by leaf-key policy
 * because their leaves are caller-chosen -- an argument named `plan` or a content
 * entry keyed `text` reads as innocuous and carries Evaluation Context anyway.
 *
 * This server never enables those options, so nothing should ever match. It is
 * here so that turning one on later fails closed instead of shipping the payload.
 */
const DENIED_SPAN_ATTRIBUTE_PREFIXES = ["mcp.request.argument", "mcp.tool.result.content"];

/**
 * OpenTelemetry attribute names are dotted namespaces, and `normalize()` in
 * redaction-rules.ts folds `_`/`-` but not `.`. Without splitting, a key like
 * `mcp.request.argument.email` reaches the value scrubber as one opaque name and
 * the leaf-key policy never sees the `email` it ends in.
 */
function spanAttributeKeyIsPii(key: string): boolean {
  if (DENIED_SPAN_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  return key.split(".").some(isPiiKey);
}

function scrubSpanAttributes(data: unknown, options: ScrubOptions): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return scrubValue(data, options);
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key)) {
      output[key] = value;
    } else {
      output[key] = spanAttributeKeyIsPii(key) ? REDACTED : scrubValue(value, options);
    }
  }
  return output;
}

/**
 * Scrub a Sentry span payload — the `beforeSendSpan` body, which the SDK invokes
 * for the transaction and every child span.
 *
 * This exists because `beforeSend` covers ERROR events only. With
 * `tracesSampleRate: 1` every Worker ships spans, so without this hook the whole
 * trace payload bypasses the redaction contract that the event path enforces.
 */
export function scrubSentrySpan<T extends SentryEventLike>(span: T, options: ScrubOptions = {}): T {
  const output: SentryEventLike = {};
  for (const [key, value] of Object.entries(span)) {
    if (ALLOWED_SPAN_KEYS.has(key)) {
      output[key] = value;
    } else if (key === "data") {
      output[key] = scrubSpanAttributes(value, options);
    } else {
      output[key] = scrubValue(value, options);
    }
  }
  return output as T;
}

/**
 * Transaction-event keys `beforeSendSpan` already covered, or that are pure trace
 * structure. The SDK runs `beforeSendSpan` FIRST and hands it both
 * `contexts.trace` (round-tripped through `convertTransactionEventToSpanJson`)
 * and every entry in `spans` (@sentry/core `client.js` `processBeforeSend`), so
 * re-scrubbing them here would corrupt trace ids and redact the very attributes
 * the span allow-list just vouched for.
 */
const ALLOWED_TRANSACTION_KEYS = new Set<string>([
  "type",
  "start_timestamp",
  "measurements",
  "spans",
]);

/**
 * Scrub a Sentry transaction event — the `beforeSendTransaction` body.
 *
 * `beforeSend` fires for ERROR events only, and `beforeSendSpan` sees only the
 * span slice of a transaction. Everything else on the transaction envelope is
 * unhooked: `requestDataIntegration` is a default integration in
 * `@sentry/cloudflare` and attaches `request` — Authorization header, cookies,
 * and query string — to transactions too, alongside `breadcrumbs`, `tags`, and
 * `extra`. Without this hook that payload bypasses the redaction contract the
 * event path enforces (ADR-0032).
 */
export function scrubSentryTransaction<T extends SentryEventLike>(
  event: T,
  options: ScrubOptions = {},
): T {
  const output: SentryEventLike = {};
  for (const [key, value] of Object.entries(event)) {
    if (ALLOWED_TRANSACTION_KEYS.has(key)) {
      output[key] = value;
    } else if (key === "contexts") {
      output[key] = scrubTransactionContexts(value, options);
    } else {
      output[key] = scrubEventField(key, value, options);
    }
  }
  return output as T;
}

/**
 * Only `contexts.trace` went through `beforeSendSpan`. Sibling contexts
 * (`response`, `runtime`, anything an integration adds later) never did, so they
 * take the ordinary scrub.
 */
function scrubTransactionContexts(contexts: unknown, options: ScrubOptions): unknown {
  if (typeof contexts !== "object" || contexts === null || Array.isArray(contexts)) {
    return scrubValue(contexts, options);
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(contexts as Record<string, unknown>)) {
    output[key] = key === "trace" ? value : scrubValue(value, options);
  }
  return output;
}
