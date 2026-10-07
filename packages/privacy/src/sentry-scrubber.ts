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
  assertSentryEventType(event);
  const output: SentryEventLike = {};
  for (const [key, value] of Object.entries(event)) {
    output[key] = scrubEventField(key, value, options);
  }
  return output as T;
}

function scrubEventField(key: string, value: unknown, options: ScrubOptions): unknown {
  if (ALLOWED_TOP_LEVEL_KEYS.has(key)) return value;
  if (key === "user") return scrubUser(value, options);
  if (key === "contexts") return scrubContexts(value, options);
  return scrubValue(value, options);
}

/**
 * Span-payload keys that are structural (identity, parentage, timing) or a closed
 * SDK vocabulary. Everything NOT in this set is scrubbed, mirroring the event
 * strategy above.
 *
 * `name` is deliberately ABSENT. A span name is closed-vocabulary only for
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
  "end_timestamp",
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
  "sentry.segment.id",
  "sentry.environment",
  "sentry.release",
  "sentry.sdk.name",
  "sentry.sdk.version",
  "sentry.sdk.integrations",
  "sentry.trace_lifecycle",
  "sentry.op",
  "sentry.origin",
  "sentry.status.message",
  "db.system.name",
  "mcp.method.name",
  "mcp.tool.name",
  "mcp.resource.uri",
  "mcp.prompt.name",
  "mcp.transport",
  "network.transport",
  "mcp.tool.result.is_error",
  "mcp.tool.result.content_count",
  "db.system",
  "db.operation.name",
  "db.response.returned_rows",
  "http.request.method",
  "http.response.status_code",
  "rpc.system",
  "rpc.method",
  "rpc.response.status_code",
  "tinybird.pipe.name",
  "panel.app.count",
  "panel.environment.count",
  "panel.membership.count",
  "session.pending_resync",
  "session.resync_attempted",
  "session.resync_succeeded",
  "auth.result",
]);

function scrubSpanAttributes(data: unknown, options: ScrubOptions): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return scrubValue(data, options);
  }
  const output: Record<string, unknown> = {};
  const isHttpClient = (data as Record<string, unknown>)["sentry.op"] === "http.client";
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    output[key] = scrubSpanAttribute(key, value, isHttpClient, options);
  }
  return output;
}

function scrubSpanAttribute(
  key: string,
  value: unknown,
  isHttpClient: boolean,
  options: ScrubOptions,
): unknown {
  if (ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key)) return value;
  if (key === "sentry.segment.name") return isHttpClient ? REDACTED : scrubValue(value, options);
  // Sentry's fetch integration records full URLs and query strings under
  // several evolving attribute names. Fail closed for every attribute that
  // has not been explicitly vouched for above.
  return REDACTED;
}

/**
 * Scrub a Sentry span payload — the `beforeSendSpan` body, which the SDK invokes
 * as each streamed span finishes.
 *
 * This exists because `beforeSend` covers ERROR events only. With
 * `tracesSampleRate: 1` every Worker ships spans, so without this hook the whole
 * trace payload bypasses the redaction contract that the event path enforces.
 */
export function scrubSentrySpan<T extends SentryEventLike>(span: T, options: ScrubOptions = {}): T {
  const output: SentryEventLike = {};
  for (const [key, value] of Object.entries(span)) {
    output[key] = scrubSpanField(span, key, value, options);
  }
  return output as T;
}

function scrubSpanField(
  span: SentryEventLike,
  key: string,
  value: unknown,
  options: ScrubOptions,
): unknown {
  if (ALLOWED_SPAN_KEYS.has(key)) return value;
  if (key === "attributes" || key === "data") return scrubSpanAttributes(value, options);
  const op = (span.attributes as Record<string, unknown> | undefined)?.["sentry.op"] ?? span.op;
  if ((key === "name" || key === "description") && op === "http.client") return REDACTED;
  return scrubValue(value, options);
}

/** Reject the retired transaction envelope before it can bypass span scrubbing. */
export function assertSentryEventType(event: SentryEventLike): void {
  if (event.type === "transaction") {
    throw new Error("privacy: Sentry transaction events are unsupported; use streamed spans");
  }
}

/** Error trace contexts retain the static trace shape, including `data`. */
function scrubContexts(contexts: unknown, options: ScrubOptions): unknown {
  if (typeof contexts !== "object" || contexts === null || Array.isArray(contexts)) {
    return scrubValue(contexts, options);
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(contexts as Record<string, unknown>)) {
    if (key === "trace" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      output[key] = scrubSentrySpan(value as SentryEventLike, options);
    } else {
      output[key] = scrubValue(value, options);
    }
  }
  return output;
}
